import { randomBytes } from 'crypto';
import { JWTVerifyGetKey } from 'jose';
import { PactBrand, PactConfig, pactUrls } from '../config';
import { getPactKey } from '../keys';
import { PlatformAuth, verifyPlatformJwt } from './auth';
import { consentPage, displayName, errorPage } from './pages';
import { Grant, PactStore } from './store';
import {
  randomToken,
  sha256,
  signConsentSession,
  signDelegationToken,
  verifyAssertion,
  verifyConsentSession,
} from './tokens';

// Authorization server for one Brand (spec §5.3): RFC 8414 metadata, JWKS, RFC 8628 device
// authorization and token endpoints, and the consent step the Brand login returns to.

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEVICE_CODE_TTL_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const GRANT_TTL_MS = 30 * 24 * 3600 * 1000;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export const parseScope = (scope: string): string[] => [...new Set(scope.split(' ').filter(Boolean))];
export const formatScope = (scopes: readonly string[]): string => [...new Set(scopes)].join(' ');

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore });
const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);
const unauthorized = () =>
  new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="a2a"' } });

function userCode(): string {
  const chars = [...randomBytes(8)].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export type DeviceAuthorizationResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

/** Spec §5.3: the link goes to the Brand's own login, which returns to our consent page. */
export async function startDeviceAuthorization(
  store: PactStore,
  input: { brandId: string; urls: ReturnType<typeof pactUrls>; platformIssuer: string; scopes: string[]; now: Date }
): Promise<DeviceAuthorizationResponse | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const deviceCode = randomToken('dc_');
    const code = userCode();
    const created = await store.createDeviceAuthorization(
      {
        deviceHash: sha256(deviceCode),
        brandId: input.brandId,
        platformIssuer: input.platformIssuer,
        clientId: input.platformIssuer,
        userCode: code,
        requestedScope: formatScope(input.scopes),
        intervalSeconds: POLL_INTERVAL_SECONDS,
        expiresAtMs: input.now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000,
      },
      input.now
    );
    if (!created) continue; // user_code collision
    const login = (returnTo: string) => `${input.urls.login}?${new URLSearchParams({ return_to: returnTo })}`;
    return {
      device_code: deviceCode,
      user_code: code,
      verification_uri: login(input.urls.consent),
      verification_uri_complete: login(`${input.urls.consent}?${new URLSearchParams({ user_code: code })}`),
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
    };
  }
  return undefined;
}

export type OAuthOptions = {
  store: PactStore;
  config: PactConfig;
  getJwks?: (uri: string) => JWTVerifyGetKey;
  now?: () => Date;
};

export function createOAuthHandler(options: OAuthOptions) {
  const { store, config } = options;
  const now = () => options.now?.() ?? new Date();

  return async (request: Request, brand: PactBrand, path: string[]): Promise<Response> => {
    if (brand.scopes.length === 0) return new Response(null, { status: 404 });
    const urls = pactUrls(config.baseUrl, brand.id);
    const route = `${request.method} ${path.join('/')}`;

    if (route === 'GET jwks.json') {
      const key = await getPactKey();
      return Response.json(key.jwks, { headers: { 'Cache-Control': 'public, max-age=300' } });
    }
    if (route === 'GET .well-known/oauth-authorization-server') {
      return Response.json({
        issuer: urls.issuer,
        device_authorization_endpoint: urls.deviceAuthorization,
        token_endpoint: urls.token,
        jwks_uri: urls.jwks,
        scopes_supported: brand.scopes.map((s) => s.id),
        grant_types_supported: [DEVICE_CODE_GRANT, 'refresh_token'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
      });
    }
    if (route === 'POST device_authorization' || route === 'POST token') return clientEndpoint(request, route, brand, urls);
    if (route === 'POST consent') return consent(request, brand, urls);
    if (route === 'POST consent/decision') return decision(request, brand, urls);
    return new Response(null, { status: 404 });
  };

  async function clientEndpoint(
    request: Request,
    route: string,
    brand: PactBrand,
    urls: ReturnType<typeof pactUrls>
  ): Promise<Response> {
    // The personal agent authenticates with its §3 JWT, on every call including the token call.
    const auth: PlatformAuth | null = await verifyPlatformJwt({
      authorization: request.headers.get('authorization'),
      defaultAudience: config.audience,
      store,
      ...(options.getJwks ? { getJwks: options.getJwks } : {}),
      now,
    });
    if (!auth) return unauthorized();

    const form = new URLSearchParams(await request.text());
    if (form.get('client_id') !== auth.issuer) {
      return oauthError('invalid_client', 'client_id must equal the personal-agent issuer', 401);
    }
    const at = now();

    if (route === 'POST device_authorization') {
      const scopes = parseScope(form.get('scope') ?? '');
      const known = new Set(brand.scopes.map((s) => s.id));
      if (scopes.length === 0 || scopes.some((s) => !known.has(s))) {
        return oauthError('invalid_scope', 'Request scope ids listed on the Agent Card');
      }
      const started = await startDeviceAuthorization(store, {
        brandId: brand.id,
        urls,
        platformIssuer: auth.issuer,
        scopes,
        now: at,
      });
      if (started) return json(started);
      return oauthError('server_error', 'Could not allocate a user code', 500);
    }

    const grantType = form.get('grant_type');
    if (grantType === DEVICE_CODE_GRANT) {
      const hash = sha256(form.get('device_code') ?? '');
      const row = await store.getDevice(hash);
      if (!row || row.brandId !== brand.id || row.clientId !== auth.issuer) {
        return oauthError('invalid_grant', 'Unknown device_code');
      }
      if (row.expiresAtMs <= at.getTime()) return oauthError('expired_token', 'The device code expired');
      if (row.status === 'denied') return oauthError('access_denied', 'The user denied access');
      if (row.status === 'consumed') return oauthError('invalid_grant', 'device_code was used');
      if (row.status === 'pending') {
        const tooSoon = row.lastPolledAtMs !== undefined && at.getTime() - row.lastPolledAtMs < row.intervalSeconds * 1000;
        await store.touchPoll(hash, at);
        return tooSoon ? oauthError('slow_down', 'Poll less often') : oauthError('authorization_pending', 'Waiting for the user');
      }
      const consumed = await store.consumeDevice(hash);
      const grant = consumed?.grantId ? await store.getGrant(consumed.grantId) : undefined;
      if (!grant) return oauthError('invalid_grant', 'device_code was used');
      return json(await issueTokens(grant, urls, at));
    }

    if (grantType === 'refresh_token') {
      const grantId = await store.useRefreshToken(sha256(form.get('refresh_token') ?? ''), at);
      const grant = grantId ? await store.getGrant(grantId) : undefined;
      if (
        !grant ||
        grant.brandId !== brand.id ||
        grant.clientId !== auth.issuer ||
        grant.revokedAtMs !== undefined ||
        grant.expiresAtMs <= at.getTime()
      ) {
        return oauthError('invalid_grant', 'Unknown or expired refresh_token');
      }
      return json(await issueTokens(grant, urls, at));
    }
    return oauthError('unsupported_grant_type', 'Unsupported grant_type');
  }

  async function issueTokens(grant: Grant, urls: ReturnType<typeof pactUrls>, at: Date) {
    const accessToken = await signDelegationToken(
      {
        iss: urls.issuer,
        aud: urls.interfaceUrl,
        sub: grant.brandUserId,
        client_id: grant.clientId,
        scope: grant.scope,
        grant_id: grant.id,
      },
      { now: at, ttlSeconds: ACCESS_TOKEN_TTL_SECONDS }
    );
    const refreshToken = randomToken('rt_');
    await store.putRefreshToken(sha256(refreshToken), grant.id, grant.expiresAtMs);
    return {
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: grant.scope,
    };
  }

  async function pending(brand: PactBrand, code: string) {
    const row = await store.getDeviceByUserCode(code);
    if (!row || row.brandId !== brand.id || row.status !== 'pending' || row.expiresAtMs <= now().getTime()) return undefined;
    const platform = await store.getPlatformByIssuer(row.platformIssuer);
    return platform ? { row, platform } : undefined;
  }

  // The Brand login POSTs a single-use assertion bound to the user_code, then the User sees consent.
  async function consent(request: Request, brand: PactBrand, urls: ReturnType<typeof pactUrls>): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    let login;
    try {
      login = await verifyAssertion(form.get('assertion') ?? '', {
        issuer: config.baseUrl,
        audience: urls.consent,
        now: now(),
      });
    } catch {
      return errorPage(brand.name, 'The sign-in could not be verified. Try again.', 401);
    }
    if (!(await store.claimAssertion(login.jti, now()))) {
      return errorPage(brand.name, 'This sign-in link was already used.');
    }
    const found = await pending(brand, login.userCode);
    if (!found) return errorPage(brand.name, 'This request expired. Start again from your agent.');
    const requested = new Set(parseScope(found.row.requestedScope));
    return consentPage({
      brandName: brand.name,
      platformName: found.platform.name,
      platformOrigin: new URL(found.row.clientId).host,
      email: login.email,
      scopes: brand.scopes.map((s) => ({ ...s, requested: requested.has(s.id) })),
      action: urls.consentDecision,
      session: await signConsentSession(login, { audience: urls.consentDecision, now: now() }),
    });
  }

  async function decision(request: Request, brand: PactBrand, urls: ReturnType<typeof pactUrls>): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    let session;
    try {
      session = await verifyConsentSession(form.get('session') ?? '', { audience: urls.consentDecision, now: now() });
    } catch {
      return errorPage(brand.name, 'This consent page expired. Start again from your agent.');
    }
    const found = await pending(brand, session.userCode);
    if (!found) return errorPage(brand.name, 'This request expired. Start again from your agent.');

    const requested = parseScope(found.row.requestedScope);
    const chosen = new Set(form.getAll('scope'));
    const granted = requested.filter((s) => chosen.has(s)); // never more than the agent asked for
    const at = now();
    const done = new URL(urls.connected);
    done.searchParams.set('client', displayName(found.platform.name));

    if (form.get('decision') !== 'allow' || granted.length === 0) {
      await store.denyDevice(found.row.deviceHash, session.sub);
      done.searchParams.set('status', 'denied');
      return Response.redirect(done, 303);
    }
    const grant: Grant = {
      id: `a2agrant_${randomBytes(16).toString('hex')}`,
      brandId: brand.id,
      platformIssuer: found.row.platformIssuer,
      clientId: found.row.clientId,
      brandUserId: session.sub,
      scope: formatScope(granted),
      expiresAtMs: at.getTime() + GRANT_TTL_MS,
      createdAtMs: at.getTime(),
    };
    if (!(await store.approveDevice(found.row.deviceHash, grant, at))) {
      return errorPage(brand.name, 'This request was already answered.');
    }
    done.searchParams.set('status', 'approved');
    done.searchParams.set('scope', grant.scope);
    return Response.redirect(done, 303);
  }
}
