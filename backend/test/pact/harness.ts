import { createLocalJWKSet, exportJWK, generateKeyPair, JWK, SignJWT } from 'jose';
import { randomUUID } from 'crypto';
import { pactConfig, pactUrls } from '../../src/pact/config';
import { resetPactKeyForTests } from '../../src/pact/keys';
import { AgentDeps, OrderSummary } from '../../src/pact/provider/agent';
import { createA2AHandler } from '../../src/pact/provider/handler';
import { createRegisterHandler } from '../../src/pact/provider/register';
import { createDocClient, PactStore } from '../../src/pact/provider/store';
import { signAssertion } from '../../src/pact/assertion';

export const BASE = 'https://smitty-api.test';
export const BRAND = '01M3R53Q5XD7T2VYB6ZC9D0HEK';
export const OTHER_BRAND = 'unknown-brand';

export const ORDER: OrderSummary = {
  id: 'ord-1',
  createdAt: '2026-10-01T12:00:00Z',
  currency: 'USD',
  totalCents: 2599,
  status: 'processing',
  items: [{ title: 'Spiral Notebook', quantity: 2, status: 'processing' }],
};

export async function newPrivateJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return JSON.stringify(await exportJWK(privateKey));
}

/**
 * One Provider (one signing key, one store, one handler) that any number of personal agents
 * talk to. The Provider's signing key is process-wide in production, so tests that need a
 * second personal agent add an agent to the same Provider rather than building a second one.
 */
export async function makeProvider(opts: { orders?: OrderSummary[] } = {}) {
  process.env.PACT_ENABLED = 'true';
  process.env.PACT_BASE_URL = BASE;
  process.env.PACT_BRAND_PRIVATE_JWK = await newPrivateJwk();
  delete process.env.PACT_SIGNING_KEY_SSM_PARAMETER;
  resetPactKeyForTests();
  const config = pactConfig()!;

  // Test time follows the real clock plus an adjustable offset, so tokens the tests sign with
  // real time (login assertions) and the Provider's notion of "now" never drift apart.
  const clock = { skewMs: 0 };
  const now = () => new Date(Date.now() + clock.skewMs);
  const advance = (ms: number) => { clock.skewMs += ms; };
  const resetClock = () => { clock.skewMs = 0; };

  const jwks = new Map<string, JWK[]>();
  const getJwks = (uri: string) => createLocalJWKSet({ keys: jwks.get(uri) ?? [] });

  const store = new PactStore(createDocClient(), 'pact-test');
  const calls: { listOrders: string[]; general: number } = { listOrders: [], general: 0 };
  const deps: AgentDeps = {
    async generalReply() {
      calls.general++;
      return 'We are open every day.';
    },
    async listOrders(sub) {
      calls.listOrders.push(sub);
      return opts.orders ?? [ORDER];
    },
  };
  const handler = createA2AHandler({ store, config, deps, getJwks, now });
  const register = createRegisterHandler({ store, baseUrl: BASE, allowLocalhost: false, getJwks, now });
  const urls = pactUrls(BASE, BRAND);

  async function formPost(url: string, form: Record<string, string | string[]>, token?: string) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
    const u = new URL(url);
    return handler(
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body }),
      u.pathname.split('/')[2],
      u.pathname.replace(/^\/a2a\/[^/]+\/?/, '').split('/').filter(Boolean)
    );
  }

  const provider = { config, store, calls, handler, register, getJwks, jwks, urls, now, advance, resetClock, formPost };
  return { ...provider, newAgent: () => makeAgent(provider) };
}

type Provider = Omit<Awaited<ReturnType<typeof makeProvider>>, 'newAgent'>;

async function makeAgent(p: Provider) {
  const { config, urls, now } = p;
  const pa = await generateKeyPair('ES256', { extractable: true });
  const paJwk: JWK = { ...(await exportJWK(pa.publicKey)), kid: 'pa-key-1', alg: 'ES256', use: 'sig' };
  const issuer = `https://pa-${randomUUID().slice(0, 8)}.example.com`;
  const jwksUri = `${issuer}/.well-known/jwks.json`;
  p.jwks.set(jwksUri, [paJwk]);

  async function paJwt(over: { sub?: string; aud?: string; iss?: string; iat?: number; exp?: number; kid?: string; key?: typeof pa.privateKey } = {}) {
    const iat = over.iat ?? Math.floor(now().getTime() / 1000);
    return new SignJWT({ sub: over.sub ?? 'user-1' })
      .setProtectedHeader({ alg: 'ES256', kid: over.kid ?? 'pa-key-1', typ: 'JWT' })
      .setIssuer(over.iss ?? issuer)
      .setAudience(over.aud ?? config.audience)
      .setIssuedAt(iat)
      .setExpirationTime(over.exp ?? iat + 120)
      .sign(over.key ?? pa.privateKey);
  }

  async function call(path: string, init: { method?: string; token?: string | null; body?: unknown; raw?: string; headers?: Record<string, string>; sub?: string } = {}) {
    const headers = new Headers(init.headers);
    const token = init.token === null ? undefined : (init.token ?? (await paJwt({ sub: init.sub })));
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (init.body !== undefined || init.raw !== undefined) headers.set('content-type', 'application/json');
    const url = new URL(`${BASE}/a2a/${path}`);
    const segments = url.pathname.replace(/^\/a2a\/[^/]+\/?/, '').split('/').filter(Boolean);
    return p.handler(
      new Request(url, { method: init.method ?? 'GET', headers, ...(init.raw !== undefined ? { body: init.raw } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }),
      url.pathname.split('/')[2],
      segments
    );
  }

  const send = (text: string, o: { contextId?: string; messageId?: string; sub?: string; delegation?: string; token?: string | null; brand?: string } = {}) =>
    call(`${o.brand ?? BRAND}/message:send`, {
      method: 'POST',
      sub: o.sub,
      token: o.token,
      headers: o.delegation ? { 'x-a2a-user-delegation': `Bearer ${o.delegation}` } : undefined,
      body: { message: { messageId: o.messageId ?? randomUUID(), ...(o.contextId ? { contextId: o.contextId } : {}), role: 'ROLE_USER', parts: [{ text }] } },
    });

  async function registerPa(name = `pa-${randomUUID().slice(0, 8)}`) {
    const iat = Math.floor(now().getTime() / 1000);
    const token = await new SignJWT({ sub: issuer })
      .setProtectedHeader({ alg: 'ES256', kid: 'pa-key-1', typ: 'JWT' })
      .setIssuer(issuer).setAudience(`${BASE}/api/platforms`).setJti(randomUUID())
      .setIssuedAt(iat).setExpirationTime(iat + 120)
      .sign(pa.privateKey);
    return p.register(new Request(`${BASE}/api/platforms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, jwksUri }),
    }));
  }

  async function startDevice(scope = 'orders:read', clientId = issuer) {
    const res = await p.formPost(urls.deviceAuthorization, { client_id: clientId, scope }, await paJwt());
    return { res, body: await res.json().catch(() => ({})) };
  }

  // The Brand login: a signed assertion for the user_code, as /pact/login would produce.
  async function login(userCode: string, sub = 'auth0|user-1', email = 'jane@example.com', over: { aud?: string } = {}) {
    const assertion = await signAssertion({ iss: BASE, aud: over.aud ?? urls.consent, sub, email, userCode });
    return p.formPost(urls.consent, { assertion });
  }

  const hidden = (html: string, name: string) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1] ?? '';

  async function approve(scope = 'orders:read', o: { sub?: string; choose?: string[]; decision?: string } = {}) {
    const { body } = await startDevice(scope);
    const consent = await login(body.user_code, o.sub);
    const page = await consent.text();
    const decision = await p.formPost(urls.consentDecision, {
      session: hidden(page, 'session'),
      decision: o.decision ?? 'allow',
      scope: o.choose ?? scope.split(' '),
    });
    return { device: body, consent, page, decision };
  }

  const exchange = async (deviceCode: string) =>
    p.formPost(urls.token, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: issuer }, await paJwt());

  const refresh = async (refreshToken: string) =>
    p.formPost(urls.token, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: issuer }, await paJwt());

  async function getDelegationToken(o: { scope?: string; sub?: string; choose?: string[] } = {}) {
    const done = await approve(o.scope ?? 'orders:read', { sub: o.sub, choose: o.choose });
    if (done.decision.status !== 303) throw new Error(`consent decision should redirect, got ${done.decision.status}`);
    const tokenRes = await exchange(done.device.device_code);
    return { ...done, token: await tokenRes.json(), tokenRes };
  }

  return { ...p, pa, paJwk, issuer, jwksUri, paJwt, call, send, registerPa, startDevice, login, hidden, approve, exchange, refresh, getDelegationToken };
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;
export type Agent = Awaited<ReturnType<typeof makeAgent>>;

/** A Provider plus one personal agent: what most tests need. */
export async function makeHarness(opts: { orders?: OrderSummary[] } = {}) {
  const provider = await makeProvider(opts);
  const agent = await provider.newAgent();
  return { ...agent, newAgent: provider.newAgent };
}
