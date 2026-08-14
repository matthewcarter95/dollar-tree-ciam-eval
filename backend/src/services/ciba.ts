const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN!;
const CIBA_CLIENT_ID = process.env.AUTH0_CIBA_CLIENT_ID!;
const CIBA_CLIENT_SECRET = process.env.AUTH0_CIBA_CLIENT_SECRET!;
const CIBA_AUDIENCE = process.env.AUTH0_CIBA_AUDIENCE!;

export interface CibaInitResult {
  authReqId: string;
  expiresIn: number;
  interval: number;
}

export async function initiateCiba(sub: string, bindingMessage: string): Promise<CibaInitResult> {
  // Auth0 only allows alphanumerics, whitespace, and +-_.,:# in binding_message
  const safeMessage = bindingMessage.replace(/[^a-zA-Z0-9\s+\-_.,:#]/g, '');

  // login_hint must be a JSON object identifying the user by Auth0 sub
  const loginHint = JSON.stringify({
    format: 'iss_sub',
    iss: `https://${AUTH0_DOMAIN}/`,
    sub,
  });

  const body = new URLSearchParams({
    client_id: CIBA_CLIENT_ID,
    client_secret: CIBA_CLIENT_SECRET,
    login_hint: loginHint,
    scope: 'openid',
    audience: CIBA_AUDIENCE,
    binding_message: safeMessage,
    request_expiry: '180',
  });

  const res = await fetch(`https://${AUTH0_DOMAIN}/bc-authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CIBA initiation failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { auth_req_id: string; expires_in: number; interval: number };
  return {
    authReqId: data.auth_req_id,
    expiresIn: data.expires_in,
    interval: data.interval ?? 5,
  };
}

export async function pollCibaUntilDone(
  authReqId: string,
  intervalSecs: number,
  maxWaitMs: number,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  let pollEvery = Math.max(intervalSecs, 3) * 1000;

  while (Date.now() < deadline) {
    await sleep(pollEvery);

    const body = new URLSearchParams({
      grant_type: 'urn:openid:params:grant-type:ciba',
      client_id: CIBA_CLIENT_ID,
      client_secret: CIBA_CLIENT_SECRET,
      auth_req_id: authReqId,
    });

    const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (res.ok) {
      // 200 — user approved, access token issued
      return;
    }

    const err = await res.json() as { error?: string };
    switch (err.error) {
      case 'authorization_pending':
        // still waiting — continue loop
        break;
      case 'slow_down':
        pollEvery += 5_000;
        break;
      case 'access_denied':
        throw new Error('CIBA_DENIED');
      case 'expired_token':
        throw new Error('CIBA_EXPIRED');
      default:
        throw new Error(`CIBA poll error: ${err.error}`);
    }
  }

  throw new Error('CIBA_TIMEOUT');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
