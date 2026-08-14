/**
 * Auth0 Management API service.
 * Uses client_credentials grant on the DT Chatbot app itself (client_credentials
 * grant + Management API client grant added during setup).
 */

interface M2MToken {
  value: string;
  expiresAt: number;
}

let cachedToken: M2MToken | null = null;

async function getM2MToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }
  const res = await fetch(
    `https://${process.env.AUTH0_DOMAIN}/oauth/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: process.env.AUTH0_CLIENT_ID,
        client_secret: process.env.AUTH0_CLIENT_SECRET,
        audience: `https://${process.env.AUTH0_DOMAIN}/api/v2/`,
      }),
    }
  );
  const data = (await res.json()) as { access_token: string; expires_in: number };
  if (!data.access_token) throw new Error('Failed to get M2M token');
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

function mgmtUrl(path: string) {
  return `https://${process.env.AUTH0_DOMAIN}/api/v2${path}`;
}

async function mgmtFetch(method: string, path: string, body?: object) {
  const token = await getM2MToken();
  const res = await fetch(mgmtUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Management API ${method} ${path} failed: ${err}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface Auth0User {
  user_id: string;
  name: string;
  email: string;
  phone_number?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AuthMethod {
  id: string;
  type: string;
  name?: string;
  confirmed: boolean;
  created_at: string;
}

export function getUser(userId: string): Promise<Auth0User> {
  return mgmtFetch('GET', `/users/${encodeURIComponent(userId)}`) as Promise<Auth0User>;
}

export function updateUser(
  userId: string,
  patch: { name?: string; phone_number?: string; user_metadata?: Record<string, unknown> }
): Promise<Auth0User> {
  return mgmtFetch('PATCH', `/users/${encodeURIComponent(userId)}`, patch) as Promise<Auth0User>;
}

export function listMfaFactors(userId: string): Promise<AuthMethod[]> {
  return mgmtFetch('GET', `/users/${encodeURIComponent(userId)}/authentication-methods`) as Promise<AuthMethod[]>;
}

export function deleteMfaFactor(userId: string, methodId: string): Promise<null> {
  return mgmtFetch(
    'DELETE',
    `/users/${encodeURIComponent(userId)}/authentication-methods/${encodeURIComponent(methodId)}`
  ) as Promise<null>;
}

export interface MfaAssociateResult {
  id: string;
  authSession: string;
  authenticatorType: string;
  secret: string;
  barcodeUri: string;
  recoveryCodes?: string[];
}

const MYACCOUNT_DOMAIN = process.env.AUTH0_DOMAIN!;

/**
 * Creates a Guardian enrollment ticket via the Management API.
 * This generates the proper enrollment URL for the Guardian app to scan —
 * the MyAccount API's push-notification barcode_uri carries empty scopes and
 * Guardian rejects it. The Management API ticket is the correct path.
 *
 * Returns { ticketUrl } which is shown as the QR code.
 */
export async function createGuardianEnrollmentTicket(userId: string): Promise<{ ticketUrl: string }> {
  const token = await getM2MToken();
  const res = await fetch(mgmtUrl('/guardian/enrollment-tickets'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, send_mail: false }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Guardian enrollment-tickets POST failed: ${err}`);
  }
  const data = await res.json() as { ticket_id: string; ticket_url: string };
  return { ticketUrl: data.ticket_url };
}

/**
 * Enrolls a new TOTP authenticator via Auth0's MyAccount API.
 *
 * The /me/ endpoint automatically applies to the authenticated user —
 * no userId in the URL. The access token must be a JWE issued for
 * audience https://{domain}/me/ with scope create:me:authentication_methods.
 *
 * POST https://{myaccount_domain}/me/authentication-methods
 *   Authorization: Bearer {JWE access token for /me/ audience}
 */
export async function associateTotpFactor(
  userAccessToken: string
): Promise<MfaAssociateResult> {
  const url = `https://${MYACCOUNT_DOMAIN}/me/v1/authentication-methods`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'push-notification' }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[MFA] /me/v1/authentication-methods ${res.status}:`, errBody);
    if (res.status === 401 || res.status === 403) {
      const e = new Error('ENROLL_SCOPE_MISSING') as Error & { code: string };
      e.code = 'ENROLL_SCOPE_MISSING';
      throw e;
    }
    throw new Error(`MyAccount /me/v1/authentication-methods POST failed (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as {
    id: string;
    type?: string;
    auth_session?: string;
    barcode_uri?: string;
    manual_input_code?: string;
    totp_secret?: string;
    secret?: string;
    recovery_codes?: string[];
    [key: string]: unknown;
  };

  console.log('[MFA] enrollment response keys:', Object.keys(data), '| id:', data.id);

  // Auth0 MyAccount API returns manual_input_code (not totp_secret/secret)
  const secret = data.manual_input_code ?? data.totp_secret ?? data.secret ?? '';
  const barcodeUri = data.barcode_uri ??
    (secret ? `otpauth://totp/${encodeURIComponent(process.env.APP_HOSTNAME ?? 'DT Chatbot')}?secret=${secret}&issuer=DT` : '');

  return {
    id: data.id,
    authSession: data.auth_session ?? '',
    authenticatorType: data.type ?? 'totp',
    secret,
    barcodeUri,
    recoveryCodes: data.recovery_codes,
  };
}

/**
 * Confirms a pending TOTP enrollment by verifying the first OTP code from the user's
 * authenticator app. Without this step the factor stays confirmed: false and won't
 * be usable for login challenges.
 *
 * PATCH https://{myaccount_domain}/me/v1/authentication-methods/{id}
 *   Authorization: Bearer {token with update:me:authentication_methods}
 *   { "code": "123456" }
 */
export async function confirmTotpFactor(
  factorId: string,
  authSession: string,
  userAccessToken: string
): Promise<void> {
  // POST /{id}/verify with auth_session confirms the enrollment.
  // The auth_session IS the verification proof — no OTP code is sent here.
  // For push-notification, Auth0 sends a push to the device; the user approves it
  // and the auth_session transitions to confirmed server-side.
  const url = `https://${MYACCOUNT_DOMAIN}/me/v1/authentication-methods/${encodeURIComponent(factorId)}/verify`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ auth_session: authSession }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[MFA] confirm POST /confirm ${res.status}:`, errBody);
    if (res.status === 401 || res.status === 403) {
      const e = new Error('ENROLL_SCOPE_MISSING') as Error & { code: string };
      e.code = 'ENROLL_SCOPE_MISSING';
      throw e;
    }
    if (res.status === 422 || res.status === 400) {
      const e = new Error('INVALID_OTP') as Error & { code: string };
      e.code = 'INVALID_OTP';
      throw e;
    }
    throw new Error(`MyAccount confirm TOTP PATCH failed (${res.status}): ${errBody}`);
  }
}
