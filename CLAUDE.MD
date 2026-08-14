# Chatbot App Architecture & Deployment Guidance (BFF + Auth0 + AWS)

## 1. Startup Interactive Prompts
At the beginning of a dev/deploy session, prompt the user for the following required inputs:
1. **AWS Temporary Credentials**: Prompt to ensure SSO/Identity Center login is active.
2. **Auth0 M2M Client Credentials**: Prompt for Client ID/Secret with Management API permissions (`read:current_user_metadata`, `update:current_user_metadata`).
3. **Vanity Hostname**: Prompt for desired hostname (e.g., `chat.demo-connect.us`).
   - Frontend: `{hostname}`
   - Backend API: `{hostname}-api`
4. **Auth0 Mode**: Prompt whether to build an **Embedded Experience** (Passkey with reference to `matthewcarter95/chatbot-embedded-passkey`) or a **Redirect Experience**.

---

## 2. Infrastructure & Deployment Rules

### Domain & Routing
- Domain zone: `demo-connect.us` (Route53).
- Certificates: Managed via AWS Certificate Manager (ACM) in `us-east-1` for CloudFront / Amplify.

### Frontend Deployment
- **Target**: AWS Amplify.
- Attach custom vanity domain (`{hostname}`).

### Backend Deployment (Lambda + CloudFront)
- **Target**: AWS Lambda + Function URL behind CloudFront proxy.
- **CRITICAL WORKAROUND (CFN Hook Bypass)**:
  - The org hook `AWS::EarlyValidation::PropertyValidation` blocks Lambda Function URLs in CloudFormation.
  - **Rule**: Deploy CloudFormation/CDK/SAM stack **WITHOUT** the Function URL config.
  - **Post-Deploy**: Attach and configure the Function URL via AWS CLI post-deployment (`aws lambda create-function-url-config ...`).

### LLM Foundation Model
- **Cost Rule**: Select the cheapest available LLM model in the AWS region/account via Bedrock / Marketplace (e.g., Amazon Nova Micro / Claude 3 Haiku).

---

## 3. Auth0 Confidential OAuth & Token Vault Architecture

### Auth0 Regular Web App Setup
- **Refresh Token Rotation**: `DISABLED` (Mandatory requirement for Federated Token Exchange).
- **Absolute Lifetime**: `ENABLED`.
- **Grant Types**:
  - Authorization Code (PKCE enabled)
  - Refresh Token
  - `urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token`
- **Scopes**: `openid`, `profile`, `email`, `offline_access`.
- **MyAccount API Permissions**: `read:me:connected_accounts`, `create:me:connected_accounts`, `delete:me:connected_accounts`.

### Auth0 Connection Configuration — Critical Notes

**Connection parameter must use NAME, not ID.**
The `/authorize` endpoint's `connection` parameter accepts the connection **name** (e.g., `"DT"`, `"google-oauth2"`), NOT the connection ID (e.g., `con_1nOcnmjtY4Fo1Wgl`). Passing a connection ID causes `"the connection is not enabled"` errors even when the connection is correctly enabled in the Auth0 Dashboard.

**Connection must be explicitly enabled for the application.**
After creating an Auth0 application, go to **Applications → [App Name] → Connections** in the Auth0 Dashboard and toggle ON each connection the app should use. The Management API's `enabled_clients` PATCH endpoint is blocked in some tenant configurations; the Dashboard toggle is the reliable method. The `enabled_clients: []` state on a connection does NOT automatically mean "all clients enabled."

**express-openid-connect routes — BFF cross-domain redirect fix.**
When the frontend and backend are on different subdomains (e.g., `app.domain.com` vs `api.domain.com`), the default `express-openid-connect` login route redirects to `baseURL` (the API domain) after auth. Fix: set `routes.login: false` and implement a custom login route that calls `res.oidc.login({ returnTo: 'https://frontend-hostname' })`. Note: `login()` is on `res.oidc` (write side), NOT `req.oidc` (read side, which only has `user`, `accessToken`, etc.).

**JWT signing algorithm must be RS256, not HS256.**
When creating an Auth0 Regular Web App via the Management API, the `jwt_configuration.alg` defaults to HS256 (client-secret-signed tokens). `express-openid-connect` (and most OIDC libraries) default to expecting RS256 (asymmetric, validated against the tenant JWKS). Using HS256 causes `BadRequestError: unexpected JWT alg received, expected RS256, got: HS256` during the callback. Fix: PATCH the client to set `jwt_configuration.alg = "RS256"` via the Management API immediately after creating the app:
```
PATCH /api/v2/clients/{client_id}
{"jwt_configuration": {"alg": "RS256"}}
```

**Lambda Function URL handles CORS — do NOT also use cors() middleware in Express.**
The Lambda Function URL intercepts OPTIONS preflight requests at the AWS infrastructure level (they never reach the Lambda function/Express). It also adds `Access-Control-Allow-*` headers to all matching cross-origin responses. If Express also runs `cors()` middleware, every non-OPTIONS response gets a duplicate `Access-Control-Allow-Origin` header, which browsers reject ("contains multiple values, only one is allowed"). Correct pattern:
1. Configure CORS on the Lambda Function URL: `AllowOrigins`, `AllowCredentials: true`, `AllowHeaders` (include `Cookie`), `AllowMethods: ["*"]`
2. Do NOT use `cors()` middleware in Express (or any other framework running in the Lambda function)

**`express-openid-connect` afterCallback: session is a plain serialized object, not a class instance.**
In `express-openid-connect` v2, the `session` passed to `afterCallback` is a plain JSON object, NOT an `openid-client` `TokenSet` class instance. It has no `.claims()` method and no `.user` property. The actual shape is:
`{ access_token, refresh_token, id_token, scope, expires_at, token_type, sid }`.
The `sub` (user ID) must be decoded from `session.id_token` (a raw JWT); `sid` is a direct top-level field. Correct approach:
```typescript
const payload = JSON.parse(Buffer.from(s.id_token.split('.')[1], 'base64url').toString('utf8'));
const sub = payload.sub;
const sid = s.sid ?? '';
```

**Lambda deployment packaging.**
When updating Lambda code directly with `aws lambda update-function-code --zip-file`, the zip must include `node_modules` alongside compiled JS. The SAM build handles this automatically, but manual zip-based updates require running `npm install --production` in the dist directory before zipping.

### Connections & Federated Token Exchange
- **Google Connection**: Configured with "Offline Access" enabled to retrieve Google refresh tokens.
- **Token Exchange Grant**:
  - `grant_type`: `urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token`
  - `subject_token`: Auth0 Refresh Token stored in session.
  - `subject_token_type`: `urn:ietf:params:oauth:token-type:refresh_token`
  - `requested_token_type`: `http://auth0.com/oauth/token-type/federated-connection-access-token`
- **Tool Interception**: Use Auth0 AI SDK with `@with_token_vault` decorator to lazily intercept agent tool calls and exchange refresh tokens automatically.
- **Reference Codebase**: `deepu105/auth0-token-vault-cli/tree/main/src/auth`

### Backchannel Logout & Sessions
- Implement OIDC Backchannel Logout endpoint on the BFF.
- Store active session states in **DynamoDB**.
- Frontend must poll/listen for session termination events to re-challenge the user upon revocation.

### Async CIBA Flow (Beneficiary Management)
- When user requests creating, updating, or deleting beneficiaries:
  - Trigger Auth0 **CIBA (Client Initiated Backchannel Authentication)** flow.
  - Implement a blocking UI/Backend prompt that waits out-of-band for push notification acknowledgment before committing the DynamoDB/DB transaction.
  - **Reference Implementation**: `matthewcarter95/banking-parent-delegate-dependents`
