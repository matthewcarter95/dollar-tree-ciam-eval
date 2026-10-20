import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { getPactKey } from './keys';

export const ASSERTION_TYP = 'pact-assertion+jwt';

// The Provider only accepts assertions for its own consent page, so we only ever hand
// one to that exact URL. An attacker-supplied return_to must never receive a signed assertion.
export function consentTarget(
  consentUrls: readonly string[],
  returnTo: unknown
): { userCode: string; consentUrl: string } | null {
  if (typeof returnTo !== 'string') return null;
  try {
    const url = new URL(returnTo);
    const consentUrl = consentUrls.find((c) => c === `${url.origin}${url.pathname}`);
    if (!consentUrl) return null;
    const userCode = (url.searchParams.get('user_code') ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{4,32}$/.test(userCode)) return null;
    return { userCode, consentUrl };
  } catch {
    return null;
  }
}

// Single-use login assertion (spec §5.3). `sub` is the Brand's own user id, which becomes the
// delegation token `sub`, so it must be the id the Brand's other channels use (the Auth0 user_id).
export async function signAssertion(input: {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  name?: string;
  userCode: string;
}): Promise<string> {
  const key = await getPactKey();
  return new SignJWT({
    user_code: input.userCode,
    email: input.email,
    ...(input.name ? { name: input.name } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: ASSERTION_TYP })
    .setIssuer(input.iss)
    .setAudience(input.aud)
    .setSubject(input.sub)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(key.privateKey);
}
