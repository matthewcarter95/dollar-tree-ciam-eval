import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, JWTVerifyGetKey } from 'jose';
import type { Platform, PactStore } from './store';

// Spec §3.2: the bearer token is a JWT the personal agent signs; we check it against the JWKS
// it registered. Any failure is the same bare 401, so the reason is only logged.

export interface PlatformAuth {
  platform: Platform;
  issuer: string;
  paUserId: string; // (platform, sub): the User, as far as the personal agent tells us
}

const jwksCache = new Map<string, JWTVerifyGetKey>();
export function getRemoteJwks(jwksUri: string): JWTVerifyGetKey {
  let keySet = jwksCache.get(jwksUri);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 5000, cooldownDuration: 30_000 });
    jwksCache.set(jwksUri, keySet);
  }
  return keySet;
}

export function assertPlatformJwtTiming(input: { iat: number; exp: number; now: Date }): void {
  if (input.exp - input.iat > 300) throw new Error('token lifetime exceeds five minutes');
  if (input.iat > Math.floor(input.now.getTime() / 1000) + 30) throw new Error('issued in the future');
}

export async function verifyPlatformJwt(input: {
  authorization: string | null;
  defaultAudience: string;
  store: PactStore;
  getJwks?: (uri: string) => JWTVerifyGetKey;
  now?: () => Date;
}): Promise<PlatformAuth | null> {
  const now = input.now?.() ?? new Date();
  const reject = (reason: string): null => {
    console.warn('PACT platform authentication failed:', reason);
    return null;
  };
  try {
    const token = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return reject('missing bearer token');
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256' && header.alg !== 'ES256') return reject('unexpected algorithm');
    const unverified = decodeJwt(token);
    if (typeof unverified.iss !== 'string') return reject('missing issuer');
    const platform = await input.store.getPlatformByIssuer(unverified.iss);
    if (!platform || !platform.enabled) return reject('unknown or disabled platform');
    const audience = platform.audience ?? input.defaultAudience;
    const { payload } = await jwtVerify(token, (input.getJwks ?? getRemoteJwks)(platform.jwksUri), {
      algorithms: ['RS256', 'ES256'],
      issuer: platform.issuer,
      audience,
      clockTolerance: 30,
      currentDate: now,
      requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp'],
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.aud !== audience // one string, verbatim (an array containing it is not enough)
    ) {
      return reject('invalid required claims');
    }
    assertPlatformJwtTiming({ iat: payload.iat, exp: payload.exp, now });
    return { platform, issuer: platform.issuer, paUserId: `${platform.name}:${payload.sub}` };
  } catch (err) {
    return reject(err instanceof Error ? err.message : String(err));
  }
}
