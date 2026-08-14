/**
 * Federated Token Exchange — Auth0 Token Vault
 *
 * Exchanges an Auth0 refresh token for a federated connection access token
 * (e.g., a Google OAuth access token). Required for agentic tool calls that
 * need to act on behalf of the user against third-party APIs.
 *
 * Auth0 app requirements:
 *   - Refresh Token Rotation: DISABLED
 *   - Grant type: urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token
 *   - Google connection: Offline Access enabled
 *
 * Reference: deepu105/auth0-token-vault-cli/tree/main/src/auth
 */

interface FederatedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function getFederatedToken(
  refreshToken: string,
  connection: string = 'google-oauth2'
): Promise<FederatedTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
    subject_token: refreshToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
    requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token',
    client_id: process.env.AUTH0_CLIENT_ID!,
    client_secret: process.env.AUTH0_CLIENT_SECRET!,
    connection,
  });

  const res = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token Vault exchange failed: ${err}`);
  }

  return res.json() as Promise<FederatedTokenResponse>;
}
