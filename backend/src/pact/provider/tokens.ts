import { createHash, randomBytes } from 'crypto';
import { CompactSign, createLocalJWKSet, jwtVerify, SignJWT } from 'jose';
import { ASSERTION_TYP } from '../assertion';
import { getPactKey } from '../keys';

const ACCESS_TOKEN_TYP = 'at+jwt';
const CONSENT_SESSION_TYP = 'pact-consent+jwt';
const RECEIPT_TYP = 'pact-receipt+jws';
const ALG = ['ES256'];

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

export type DelegationClaims = {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  grant_id: string;
  iat: number;
  exp: number;
};

export async function signDelegationToken(
  claims: Omit<DelegationClaims, 'iat' | 'exp'>,
  opts: { now: Date; ttlSeconds: number }
): Promise<string> {
  const key = await getPactKey();
  const iat = seconds(opts.now);
  return new SignJWT({ client_id: claims.client_id, scope: claims.scope, grant_id: claims.grant_id })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: ACCESS_TOKEN_TYP })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt(iat)
    .setExpirationTime(iat + opts.ttlSeconds)
    .sign(key.privateKey);
}

export async function verifyDelegationToken(
  token: string,
  opts: { issuer: string; audience: string; now: Date }
): Promise<DelegationClaims> {
  const key = await getPactKey();
  const { payload } = await jwtVerify(token, createLocalJWKSet(key.jwks), {
    algorithms: ALG,
    issuer: opts.issuer,
    audience: opts.audience,
    typ: ACCESS_TOKEN_TYP,
    currentDate: opts.now,
    requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
  });
  const { client_id, scope, grant_id } = payload as Record<string, unknown>;
  if (typeof client_id !== 'string' || typeof scope !== 'string' || typeof grant_id !== 'string') {
    throw new Error('Delegation token is missing client_id, scope or grant_id');
  }
  return {
    iss: String(payload.iss),
    aud: String(payload.aud),
    sub: String(payload.sub),
    client_id,
    scope,
    grant_id,
    iat: payload.iat as number,
    exp: payload.exp as number,
  };
}

export type BrandLogin = { sub: string; userCode: string; email: string; jti: string };

// The Brand's login hands the Provider this assertion (spec §5.3). Both are the same service
// here, so it is verified against our own key, never fetched over HTTP.
export async function verifyAssertion(
  token: string,
  opts: { issuer: string; audience: string; now: Date }
): Promise<BrandLogin> {
  const key = await getPactKey();
  const { payload } = await jwtVerify(token, createLocalJWKSet(key.jwks), {
    algorithms: ALG,
    issuer: opts.issuer,
    audience: opts.audience,
    typ: ASSERTION_TYP,
    currentDate: opts.now,
    maxTokenAge: '5m',
    requiredClaims: ['sub', 'jti', 'iat', 'exp'],
  });
  if (typeof payload.user_code !== 'string' || typeof payload.email !== 'string') {
    throw new Error('Assertion is missing user_code or email');
  }
  return { sub: payload.sub!, userCode: payload.user_code, email: payload.email, jti: payload.jti! };
}

export type ConsentSession = { sub: string; userCode: string; email: string };

// Binds the consent form to the login that produced it: the decision POST is only valid
// with this token, which only the page we rendered carries.
export async function signConsentSession(
  session: ConsentSession,
  opts: { audience: string; now: Date }
): Promise<string> {
  const key = await getPactKey();
  const iat = seconds(opts.now);
  return new SignJWT({ user_code: session.userCode, email: session.email })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: CONSENT_SESSION_TYP })
    .setAudience(opts.audience)
    .setSubject(session.sub)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 600)
    .sign(key.privateKey);
}

export async function verifyConsentSession(
  token: string,
  opts: { audience: string; now: Date }
): Promise<ConsentSession> {
  const key = await getPactKey();
  const { payload } = await jwtVerify(token, createLocalJWKSet(key.jwks), {
    algorithms: ALG,
    audience: opts.audience,
    typ: CONSENT_SESSION_TYP,
    currentDate: opts.now,
  });
  if (typeof payload.sub !== 'string' || typeof payload.user_code !== 'string' || typeof payload.email !== 'string') {
    throw new Error('Invalid consent session');
  }
  return { sub: payload.sub, userCode: payload.user_code, email: payload.email };
}

export type ReceiptAction = { tool: string; argsHash?: string };
export type ReceiptClaims = {
  grantId: string;
  user: string;
  pa: string;
  brand: string;
  scopesUsed: string[];
  actions: ReceiptAction[];
  ts: string;
};
export type Receipt = { jws: string; claims: ReceiptClaims };

// Spec §5.6: every reply served under a delegation token carries a signed receipt.
export async function signReceipt(claims: ReceiptClaims): Promise<Receipt> {
  const key = await getPactKey();
  const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: RECEIPT_TYP })
    .sign(key.privateKey);
  return { jws, claims };
}
