# Chatbot App Architecture & Deployment Guidance (BFF + Auth0 + AWS)

## 1. Startup Interactive Prompts

At the beginning of every dev/deploy session, collect the following inputs in order:

1. **AWS Credentials**
   Run `! aws sso login --profile btaws` to get short-term credentials via SSO/Identity Center.
   All `aws` and `sam` commands must export the resulting `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` env vars before running. Credentials expire — if a command fails with `ExpiredTokenException`, re-run the SSO login before retrying. Check the current conversation for a recent `export AWS_ACCESS_KEY_ID=...` block before asking the user to re-paste.

2. **Experience Mode** ← ask this before anything else
   > "Is this a **B2C** (customer-facing chatbot, CIAM, retail/consumer) or **B2B** (workforce, employee-facing, SSO) deployment?"
   - **B2C** → proceed with Section 4 (DT Chatbot Reference).
   - **B2B** → proceed with Section 5 (B2B stub).

3. **Auth0 M2M Client Credentials**
   Prompt for a Client ID/Secret with Management API permissions. Required scopes vary by task:
   - Basic user management: `read:users`, `update:users`, `read:authentication_methods`, `delete:authentication_methods`, `create:guardian_enrollment_tickets`
   - CIBA provisioning: additionally `create:clients`, `create:resource_servers`, `create:client_grants`
   - Full setup: use the tenant's API Explorer token or a dedicated setup app with all Management API scopes.

4. **Vanity Hostname**
   Prompt for desired hostname (e.g., `chat.demo-connect.us`).
   - Frontend: `{hostname}` (Amplify)
   - Backend API: `{hostname}-api` (CloudFront → Lambda Function URL)

5. **Auth0 Mode**
   Prompt whether to build an **Embedded Experience** (Passkey — reference: `matthewcarter95/chatbot-embedded-passkey`) or a **Redirect Experience** (express-openid-connect BFF).

---

## 2. Infrastructure & Deployment Rules

### Domain & Routing
- Domain zone: `demo-connect.us` (Route53).
- Certificates: Managed via AWS Certificate Manager (ACM) in `us-east-1` for CloudFront / Amplify.

### Frontend Deployment (Amplify)
- **Target**: AWS Amplify manual deployment (zip upload).
- Attach custom vanity domain (`{hostname}`).
- **SPA rewrite rule** — must be set or all deep-link routes return 404:
  ```
  Source: </^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json)[^.]*$)([^.]+$)/>
  Target: /index.html
  Status: 200
  ```
  Set via: `aws amplify update-app --app-id <id> --custom-rules '[{"source":"<regex>","target":"/index.html","status":"200"}]'`
- **Zip the dist contents, not the folder**: `cd dist && zip -r ../dist-root.zip .`
  If you zip the folder itself (`zip -r dist.zip dist/`), Amplify can't find `index.html` at the root.

### Backend Deployment (Lambda + CloudFront)
- **Target**: AWS Lambda + Function URL behind CloudFront proxy.
- **CRITICAL WORKAROUND (CFN Hook Bypass)**:
  The org hook `AWS::EarlyValidation::PropertyValidation` blocks Lambda Function URLs in CloudFormation.
  **Rule**: Deploy SAM/CFN stack **WITHOUT** `FunctionUrlConfig`. After deploy, attach via:
  ```bash
  aws lambda create-function-url-config --function-name <name> --auth-type NONE --cors '...'
  ```
- **SAM build caching**: `sam build` caches based on the compiled artifact hash. After a TypeScript change, run `npx tsc` first (to update `dist/`), then `sam build --no-cached` to force a rebuild.
- **CloudFront origin timeout**: Default is 30 s. For CIBA flows that poll for 90 s, update the origin:
  ```bash
  aws cloudfront update-distribution --id <dist-id> --if-match <etag> \
    --distribution-config '...OriginReadTimeout: 120...'
  ```

### LLM Foundation Model
- **Cost Rule**: Select the cheapest available model in the account via Bedrock (e.g., Amazon Nova Micro, Claude Haiku).

---

## 3. Auth0 Patterns — Critical Notes

### Connection Configuration
- **Use connection NAME, not ID.** The `/authorize` `connection` param accepts names (e.g., `"DT"`, `"google-oauth2"`), not IDs (`con_xxx`). Using an ID causes `"the connection is not enabled"` even when it is.
- **Enable each connection per application** via Dashboard → Applications → [App] → Connections. The Management API `enabled_clients` PATCH is blocked on some tenants; the toggle is reliable.

### express-openid-connect BFF
- **Cross-domain redirect fix**: Set `routes.login: false` and implement a custom `/auth/login` route calling `res.oidc.login({ returnTo: 'https://frontend-hostname' })`. Note: `login()` / `logout()` are on `res.oidc` (write), not `req.oidc` (read).
- **JWT algorithm**: Management API creates clients with HS256 by default. express-openid-connect expects RS256. Fix immediately after client creation:
  ```
  PATCH /api/v2/clients/{client_id}  {"jwt_configuration": {"alg": "RS256"}}
  ```
- **afterCallback session shape**: The `session` argument is a plain JSON object `{ access_token, refresh_token, id_token, scope, expires_at, sid }` — not a `TokenSet` instance. Decode `sub` from `id_token` manually:
  ```typescript
  const payload = JSON.parse(Buffer.from(s.id_token.split('.')[1], 'base64url').toString('utf8'));
  const sub = payload.sub;
  ```
- **Signup route**: Pass `screen_hint: 'signup'` to open Universal Login directly on the signup screen:
  ```typescript
  router.get('/signup', (_req, res) => {
    (res as any).oidc.login({ returnTo: appUrl, authorizationParams: { screen_hint: 'signup' } });
  });
  ```

### Custom Domain Split
When using an Auth0 custom domain, use **two separate env vars**:

| Variable | Value | Used for |
|---|---|---|
| `AUTH0_DOMAIN` | `custom.domain.com` | All auth endpoints: `/authorize`, `/oauth/token`, `/bc-authorize`, MyAccount `/me/` audience, CIBA `login_hint.iss` |
| `AUTH0_CANONICAL_DOMAIN` | `tenant.auth0.com` | Management API endpoint and audience (`/api/v2/`) **only** |

- The `/me/` (MyAccount) resource server audience is **hostname-bound**: use `https://{AUTH0_DOMAIN}/me/` when calling through the custom domain. Using the canonical domain here causes `"Audience ... is not accessible through this hostname"`.
- The Management API (`/api/v2/`) is **canonical-only** — custom domains do not proxy it.

### user_metadata vs app_metadata
- `app_metadata`: System-assigned, admin-controlled. Use for IDs set by external systems (e.g., `loyaltyId`, CRM IDs, roles). Not editable by the user.
- `user_metadata`: User-editable. Use for preferences, phone numbers, addresses.
- Reading from `req.oidc.user` only surfaces ID token claims (requires an Auth0 Action to include custom claims). As a fallback, read via Management API `getUser(sub).app_metadata`.

### CORS — Lambda Function URL vs Express
The Lambda Function URL handles CORS at the AWS infrastructure level (OPTIONS never reaches Express). Do NOT also use `cors()` middleware — it causes duplicate `Access-Control-Allow-Origin` headers that browsers reject.
Configure on the Function URL: `AllowOrigins`, `AllowCredentials: true`, `AllowHeaders` (include `Cookie`).

### Lambda Packaging
`sam build` handles `node_modules` automatically. For manual `update-function-code` zip deploys: `npm install --production` in the `dist/` directory before zipping.

### CIBA — Client Initiated Backchannel Authentication

**Provisioning via Management API:**
```javascript
// 1. Create resource server
POST /api/v2/resource-servers
{ "name": "My Purchases API", "identifier": "https://app.demo-connect.us/purchases" }

// 2. Create CIBA M2M client
POST /api/v2/clients
{
  "name": "App CIBA Client",
  "app_type": "non_interactive",
  "grant_types": ["client_credentials", "urn:openid:params:grant-type:ciba"],
  "oidc_conformant": true,
  "token_endpoint_auth_method": "client_secret_post",
  "async_approval_notification_channels": ["guardian-push"]  // see note below
}

// 3. Grant client access to resource server
POST /api/v2/client-grants
{ "client_id": "<ciba_client_id>", "audience": "https://app.demo-connect.us/purchases", "scope": [] }
```

**`async_approval_notification_channels` — valid values discovered by trial:**
- `"guardian-push"` ✅ — sends Guardian push to enrolled devices
- `"email"` ✅ — sends email (requires verified email address)
- All other variants (`"guardian"`, `"push"`, `"push-notification"`, `"sms"`, etc.) are **invalid** and return 400.

**bc-authorize request:**
```typescript
POST https://{AUTH0_DOMAIN}/bc-authorize
Content-Type: application/x-www-form-urlencoded

client_id=...&client_secret=...
&login_hint={"format":"iss_sub","iss":"https://{AUTH0_DOMAIN}/","sub":"auth0|user_id"}
&scope=openid&audience=https://app.domain.com/purchases
&binding_message=Buy Spiral Notebook for 100 pts   // alphanumeric + +-_.,:#  only — no parens
&request_expiry=180
```
- `binding_message` restriction: only alphanumerics, whitespace, and `` +-_.,:# `` — strip all other characters before sending.
- `login_hint.iss` must match the token issuer. Use `AUTH0_DOMAIN` (custom domain if applicable).

**Polling `/oauth/token`:**
```typescript
POST /oauth/token
grant_type=urn:openid:params:grant-type:ciba&auth_req_id=...&client_id=...&client_secret=...
```
- Response codes: `200` = approved, `400 authorization_pending` = still waiting, `400 slow_down` = poll too fast (add 5 s to interval), `400 access_denied` = rejected, `400 expired_token` = expired.
- Minimum poll interval: use the `interval` value from the `bc-authorize` response (typically 5 s). Never poll faster than 5 s — Auth0 returns `slow_down` for every call and never progresses.
- Handle `slow_down` by increasing the interval by 5 s and continuing (do NOT treat it as an error).

**Guardian enrollment prerequisite:**
- User must have Guardian push enrolled before CIBA push notifications work.
- Generate an enrollment ticket: `POST /api/v2/guardian/enrollments/ticket { "user_id": "...", "send_mail": false }` → returns `ticket_url` to display as QR code.
- One iPhone can be enrolled for multiple Auth0 accounts. When two accounts share the same device, CIBA pushes for account A can trigger a `rich_consents_access_error` if the Guardian app's active session is for account B. Always approve CIBA pushes from the same account used to log in.

**Non-blocking CIBA pattern (recommended for browser apps):**
1. Tool/route initiates CIBA, returns `auth_req_id` immediately (don't block).
2. Frontend receives `cibaState: { auth_req_id, itemName, pointsCost, interval }` in the API response.
3. Frontend shows a waiting card with a cancel button and polls `POST /api/purchase/poll` at `interval` seconds.
4. On `approved`: deduct points, update UI. On `slow_down`: increase polling interval. On `denied`/`expired`: show message.

### Federated Token Exchange (Token Vault)
- **Refresh Token Rotation**: `DISABLED` (required for Token Vault).
- Grant type: `urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token`
- `subject_token`: Auth0 Refresh Token; `subject_token_type`: `urn:ietf:params:oauth:token-type:refresh_token`
- Reference: `deepu105/auth0-token-vault-cli/tree/main/src/auth`

### Backchannel Logout & Sessions
- Implement OIDC Backchannel Logout at `POST /auth/backchannel-logout`.
- Store session state in DynamoDB (index on `sid` and `userId`).
- Frontend polls `/api/user` every 30 s; on 401, redirect to login.

---

## 4. B2C Experience: DT Chatbot Reference Implementation

> This section documents the full working implementation built for the Dollar Treasure (DT) retail chatbot at `smitty.demo-connect.us`.

### Stack
- **Frontend**: React + Vite → AWS Amplify
- **Backend**: Express + TypeScript → AWS Lambda (SAM) behind CloudFront
- **Auth**: Auth0 redirect flow (express-openid-connect), custom domain `auth0connectedapps.demo-connect.us`
- **AI**: Amazon Bedrock (Nova Micro) with tool use
- **Loyalty**: DynamoDB via external Lambda ARNs (`RetailLoyaltyPointsTracker`, `RetailPointsCoupon`)

### Auth0 Application Setup
1. **Regular Web App** (Authorization Code + PKCE + Refresh Token, RS256, rotation DISABLED).
2. **Scopes**: `openid profile email offline_access` + MyAccount scopes.
3. **Custom domain**: `auth0connectedapps.demo-connect.us` → `AUTH0_DOMAIN`. Canonical → `AUTH0_CANONICAL_DOMAIN` (Management API only).
4. **DT connection** (database connection named `"DT"`) — use connection name in `authorizationParams.connection`.
5. **Signup route**: `GET /auth/signup` with `screen_hint: 'signup'`.

### Loyalty Points Architecture
- `loyaltyId` stored in Auth0 `app_metadata` (not user_metadata). Read via Management API fallback when absent from ID token claims.
- Points tracking: `RetailLoyaltyPointsTracker` Lambda uses Lambda Function URL v2 format (GET + queryStringParameters for read; PUT + JSON body for write/increment).
  - **Read**: `GET ?loyaltyId=N` → `{ loyaltyId, totalPoints }`
  - **Write/increment**: Lambda Function URL v2 PUT `{ body: JSON.stringify({ loyaltyId: Number(id), points: N }) }` — creates record if new, increments if exists. Negative `points` decrements.
- Coupon redemption: `RetailPointsCoupon` returns `{ couponId, points }` (field is `points`, not `pointsEarned`).

### CIBA Purchase Flow
- **CIBA M2M client**: `DT CIBA Client` with `async_approval_notification_channels: ["guardian-push"]`.
- **Resource server**: `DT Purchases API` at `https://smitty.demo-connect.us/purchases`.
- **Store catalog**: Hardcoded in backend `chat.ts`. Bedrock calls `lookup_item_price` tool first to get exact `pointsCost` from catalog, then calls `purchase_with_points`.
- **Non-blocking pattern**: chat tool initiates CIBA and returns immediately; frontend polls `/api/purchase/poll` at 5 s intervals with exponential backoff on `slow_down`.

### SAM Template Notes
- Lambda timeout: **120 s** (required for CIBA polling headroom).
- Key env vars: `AUTH0_DOMAIN`, `AUTH0_CANONICAL_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_CIBA_CLIENT_ID`, `AUTH0_CIBA_CLIENT_SECRET`, `AUTH0_CIBA_AUDIENCE`, `AUTH0_CONNECTION`, `SESSION_SECRET`, `APP_HOSTNAME`, `API_HOSTNAME`, `BEDROCK_MODEL_ID`.

---

## 5. B2B Experience (stub)

> TODO — workforce/employee-facing deployment.

### Planned Stack
- **Frontend**: React + Vite → AWS Amplify (same as B2C)
- **Backend**: Express + TypeScript → AWS Lambda (SAM)
- **Auth**: Auth0 redirect flow with **Enterprise Connections** (SAML, OIDC federation, Active Directory)

### Key Differences from B2C
- Use `organization` parameter in `/authorize` for multi-tenant B2B routing.
- SSO connections managed per organization (not a single database connection).
- `app_metadata` carries org-specific roles/entitlements set by the enterprise IdP.
- Consider Auth0 Organizations API for tenant isolation.

### Steps (TBD)
- [ ] Prompt for organization domain / SAML metadata URL
- [ ] Create Auth0 Organization + Enterprise Connection
- [ ] Configure organization-level branding
- [ ] Map IdP claims to Auth0 roles
- [ ] Implement role-based tool access in the Bedrock tool handler
