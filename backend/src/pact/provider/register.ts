import { decodeJwt, decodeProtectedHeader, jwtVerify, JWTVerifyGetKey } from 'jose';
import { assertPlatformJwtTiming, getRemoteJwks } from './auth';
import type { PactStore } from './store';

// POST /api/platforms: a personal agent registers once per Provider (spec §3.1). The request
// is authenticated with a JWT signed by the key the agent is registering, so only whoever
// holds that key can claim the issuer. Registration can be limited to named issuers with
// PACT_ALLOWED_ISSUERS (comma-separated); set it on any public deployment.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function unauthorized(reason: string): Response {
  console.warn('PACT platform registration authentication failed:', reason);
  return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="platforms"' } });
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return true;
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return v6 === '::1' || v6 === '::' || /^(f[cd]|fe[89ab])/.test(v6) || v6.startsWith('::ffff:');
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function parseAllowedUrl(value: string, name: string, allowLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (local ? !allowLocalhost : isPrivateHost(url.hostname)) {
    throw new Error(`${name} must not point at a local or private address`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${name} must use https, or http on localhost`);
  }
  return url;
}

export function validateRegistrationUrls(issuer: string, jwksUri: string, allowLocalhost: boolean): void {
  if (issuer.includes('?') || issuer.includes('#')) throw new Error('Issuer must not include a query or fragment');
  const issuerUrl = parseAllowedUrl(issuer.replace(/\/+$/, ''), 'Issuer', allowLocalhost);
  const jwksUrl = parseAllowedUrl(jwksUri, 'JWKS URI', allowLocalhost);
  if (issuerUrl.origin !== jwksUrl.origin) throw new Error('JWKS URI must have the same origin as the issuer');
}

export function createRegisterHandler(options: {
  store: PactStore;
  baseUrl: string;
  allowedIssuers?: string[];
  allowLocalhost?: boolean;
  getJwks?: (uri: string) => JWTVerifyGetKey;
  now?: () => Date;
}): (request: Request) => Promise<Response> {
  const allowLocalhost = options.allowLocalhost ?? process.env.NODE_ENV !== 'production';
  const audience = `${options.baseUrl}/api/platforms`;
  const picture = (p: { id: string; name: string; issuer: string; jwksUri: string; enabled: boolean }) =>
    ({ platform: { id: p.id, name: p.name, issuer: p.issuer, jwksUri: p.jwksUri, enabled: p.enabled } });

  return async (request) => {
    let token: string;
    let issuer: string;
    let alg: string | undefined;
    try {
      const match = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i);
      if (!match?.[1]) return unauthorized('missing bearer token');
      token = match[1];
      alg = decodeProtectedHeader(token).alg;
      const claims = decodeJwt(token);
      if (typeof claims.iss !== 'string') return unauthorized('missing issuer');
      issuer = claims.iss.replace(/\/+$/, '');
    } catch (err) {
      return unauthorized(err instanceof Error ? err.message : 'invalid JWT');
    }

    if (options.allowedIssuers?.length && !options.allowedIssuers.includes(issuer)) {
      return unauthorized('issuer is not allowed to register');
    }
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') return json({ error: 'Content-Type must be application/json' }, 400);

    let body: { name?: unknown; jwksUri?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Malformed JSON request body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Object.keys(body).some((k) => k !== 'name' && k !== 'jwksUri')) {
      return json({ error: 'Body must be { name, jwksUri }' }, 400);
    }
    const { name, jwksUri } = body;
    if (typeof name !== 'string' || !NAME.test(name)) return json({ error: 'name must match ^[a-z0-9][a-z0-9-]{1,62}$' }, 400);
    if (typeof jwksUri !== 'string' || !jwksUri) return json({ error: 'jwksUri is required' }, 400);
    try {
      validateRegistrationUrls(issuer, jwksUri, allowLocalhost);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'Invalid registration URLs' }, 400);
    }

    try {
      if (alg !== 'ES256') throw new Error('unexpected algorithm');
      const { payload } = await jwtVerify(token, (options.getJwks ?? getRemoteJwks)(jwksUri), {
        algorithms: ['ES256'],
        issuer: decodeJwt(token).iss as string,
        audience,
        clockTolerance: 30,
        currentDate: options.now?.() ?? new Date(),
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'jti'],
      });
      if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') throw new Error('invalid required claims');
      assertPlatformJwtTiming({ iat: payload.iat, exp: payload.exp, now: options.now?.() ?? new Date() });
      if (typeof payload.sub !== 'string' || payload.sub.replace(/\/+$/, '') !== issuer) {
        throw new Error('subject must match issuer');
      }
    } catch (err) {
      return unauthorized(err instanceof Error ? err.message : 'JWT verification failed');
    }

    try {
      const [byIssuer, byName] = await Promise.all([options.store.getPlatformByIssuer(issuer), options.store.getPlatformByName(name)]);
      if (byIssuer && byName && byIssuer.id === byName.id && byIssuer.jwksUri === jwksUri) {
        return Response.json(picture(byIssuer), { status: 200 }); // idempotent re-registration
      }
      if (byIssuer) return json({ error: 'Issuer is already registered with different details' }, 409);
      if (byName) return json({ error: 'Platform name is already registered to another issuer' }, 409);
      const created = await options.store.createPlatform({ name, issuer, jwksUri });
      if (created) return Response.json(picture(created), { status: 201 });
      return json({ error: 'Issuer or name was just registered by another request' }, 409);
    } catch (err) {
      console.error('PACT platform registration failed', err);
      return json({ error: 'Internal error' }, 500);
    }
  };
}
