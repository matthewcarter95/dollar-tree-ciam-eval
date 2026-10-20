import { generateKeyPair, SignJWT } from 'jose';
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BRAND, makeHarness, Harness, OTHER_BRAND } from './harness';

const ddb = process.env.PACT_TEST_DDB === '1' ? describe : describe.skip;

async function error(res: Response, expected: { http: number; status: string; reason: string; message?: string }) {
  const body = await res.json();
  expect(res.status).toBe(expected.http);
  expect(res.headers.get('content-type')).toBe('application/a2a+json');
  expect(body.error).toMatchObject({
    code: expected.http,
    status: expected.status,
    details: [{ reason: expected.reason, domain: 'a2a-protocol.org' }],
    ...(expected.message ? { message: expected.message } : {}),
  });
}

async function bare(res: Response, status: number | number[]) {
  expect([status].flat()).toContain(res.status);
  expect(res.headers.get('content-type') ?? '').not.toBe('application/a2a+json');
  await res.arrayBuffer();
}

ddb('PACT Identity: Agent Card (spec §2.1)', () => {
  let h: Harness;
  beforeAll(async () => { h = await makeHarness(); await h.registerPa(); });

  it('serves the card without authentication, with an HTTP+JSON 1.0 interface', async () => {
    const res = await h.call(`${BRAND}/.well-known/agent-card.json`, { token: null });
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.supportedInterfaces).toEqual([{ url: `https://smitty-api.test/a2a/${BRAND}`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }]);
    expect(card.securitySchemes.platformJwt.httpAuthSecurityScheme).toMatchObject({ scheme: 'Bearer', bearerFormat: 'JWT' });
    expect(card.securityRequirements[0]).toEqual({ schemes: { platformJwt: { list: [] } } }); // identity-only entry stays
    expect(card.name).toBe('Dollar Treasure');
  });

  it('advertises delegation: device-code flow, scopes, RFC 8414 metadata', async () => {
    const card = await (await h.call(`${BRAND}/.well-known/agent-card.json`, { token: null })).json();
    const flow = card.securitySchemes.userDelegation.oauth2SecurityScheme;
    expect(flow.flows.deviceCode).toEqual({
      deviceAuthorizationUrl: h.urls.deviceAuthorization,
      tokenUrl: h.urls.token,
      scopes: { 'orders:read': 'View your orders and their status' },
    });
    expect(flow.oauth2MetadataUrl).toBe(h.urls.metadata);
    expect(card.securityRequirements).toContainEqual({ schemes: { platformJwt: { list: [] }, userDelegation: { list: [] } } });
  });

  it('returns a bare 404 for an unknown Brand, even with a valid token', async () => {
    await bare(await h.call(`${OTHER_BRAND}/.well-known/agent-card.json`, { token: null }), 404);
    await bare(await h.call(`${OTHER_BRAND}/tasks`), 404);
  });
});

ddb('PACT Identity: personal-agent JWT (spec §3)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    expect((await h.registerPa()).status).toBe(201);
  });

  const expectUnauthorized = async (res: Response) => {
    await bare(res, 401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="a2a"');
  };

  it('accepts a good token', async () => {
    expect((await h.call(`${BRAND}/tasks`)).status).toBe(200);
  });

  it('rejects a missing token, before reading the body', async () => {
    await expectUnauthorized(await h.call(`${BRAND}/tasks`, { token: null }));
    await expectUnauthorized(await h.call(`${BRAND}/message:send`, { method: 'POST', token: null, raw: '{' }));
  });

  it('rejects a bad signature, wrong audience, expiry, future iat, and over-long lifetime', async () => {
    const other = await generateKeyPair('ES256');
    const now = Math.floor(h.now().getTime() / 1000);
    for (const token of [
      await h.paJwt({ key: other.privateKey, kid: 'unpublished' }),
      await h.paJwt({ aud: `https://smitty-api.test/a2a/${BRAND}` }), // derived from a card URL: not the assigned audience
      await h.paJwt({ iat: now - 200, exp: now - 100 }),
      await h.paJwt({ iat: now + 31, exp: now + 151 }),
      await h.paJwt({ iat: now, exp: now + 301 }),
    ]) {
      await expectUnauthorized(await h.call(`${BRAND}/tasks`, { token }));
    }
  });

  it('allows 30 seconds of clock skew, no more', async () => {
    const now = Math.floor(h.now().getTime() / 1000);
    expect((await h.call(`${BRAND}/tasks`, { token: await h.paJwt({ iat: now + 29, exp: now + 149 }) })).status).toBe(200);
  });

  it('rejects HS256, an unknown issuer, and a disabled personal agent', async () => {
    const hs = await new SignJWT({ sub: 'u' }).setProtectedHeader({ alg: 'HS256', kid: 'pa-key-1' })
      .setIssuer(h.issuer).setAudience(h.config.audience).setIssuedAt().setExpirationTime('2m')
      .sign(new TextEncoder().encode('not-an-allowed-platform-key'));
    await expectUnauthorized(await h.call(`${BRAND}/tasks`, { token: hs }));
    await expectUnauthorized(await h.call(`${BRAND}/tasks`, { token: await h.paJwt({ iss: 'https://nobody.example.com' }) }));
    await h.store.setPlatformEnabled(h.issuer, false);
    await expectUnauthorized(await h.call(`${BRAND}/tasks`));
    await h.store.setPlatformEnabled(h.issuer, true);
    expect((await h.call(`${BRAND}/tasks`)).status).toBe(200);
  });

  it('rejects a token without sub', async () => {
    const iat = Math.floor(h.now().getTime() / 1000);
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'pa-key-1' })
      .setIssuer(h.issuer).setAudience(h.config.audience).setIssuedAt(iat).setExpirationTime(iat + 120).sign(h.pa.privateKey);
    await expectUnauthorized(await h.call(`${BRAND}/tasks`, { token }));
  });
});

ddb('PACT Identity: routing (spec §2.2)', () => {
  let h: Harness;
  beforeAll(async () => { h = await makeHarness(); await h.registerPa(); });

  it('matches routes before authentication', async () => {
    await bare(await h.call(`${BRAND}/unknown`, { token: null }), 404);
    for (const [method, path] of [['GET', 'message:send'], ['DELETE', 'message:send'], ['PUT', 'message:send'], ['POST', 'tasks'], ['DELETE', `tasks/${randomUUID()}/pushNotificationConfigs`]]) {
      await bare(await h.call(`${BRAND}/${path}`, { method, token: null }), [404, 405]);
    }
  });

  it('returns empty tasks and validates pageSize', async () => {
    expect(await (await h.call(`${BRAND}/tasks?pageSize=20&contextId=ignored`)).json()).toEqual({ tasks: [], nextPageToken: '', pageSize: 20, totalSize: 0 });
    expect((await (await h.call(`${BRAND}/tasks`)).json()).pageSize).toBe(50);
    for (const bad of ['0', '101', 'abc', '-1', '1.5']) {
      await error(await h.call(`${BRAND}/tasks?pageSize=${bad}`), { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' });
    }
    await error(await h.call(`${BRAND}/tasks?pageSize=1&pageSize=2`), { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' });
  });

  it('maps task, unsupported, and push routes to the specified A2A errors', async () => {
    const id = randomUUID();
    for (const [method, path] of [['GET', `tasks/${id}`], ['POST', `tasks/${id}:cancel`], ['POST', `tasks/${id}%3Acancel`]]) {
      await error(await h.call(`${BRAND}/${path}`, { method }), { http: 404, status: 'NOT_FOUND', reason: 'TASK_NOT_FOUND', message: `Task not found: ${id}` });
    }
    for (const [method, path] of [['POST', 'message:stream'], ['POST', `tasks/${id}:subscribe`], ['GET', 'extendedAgentCard']]) {
      await error(await h.call(`${BRAND}/${path}`, { method }), { http: 400, status: 'FAILED_PRECONDITION', reason: 'UNSUPPORTED_OPERATION' });
    }
    for (const [method, path] of [['GET', `tasks/${id}/pushNotificationConfigs`], ['POST', `tasks/${id}/pushNotificationConfigs`], ['GET', `tasks/${id}/pushNotificationConfigs/c1`], ['DELETE', `tasks/${id}/pushNotificationConfigs/c1`]]) {
      await error(await h.call(`${BRAND}/${path}`, { method }), { http: 400, status: 'FAILED_PRECONDITION', reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED' });
    }
  });
});

ddb('PACT Identity: messages (spec §4)', () => {
  let h: Harness;
  beforeAll(async () => { h = await makeHarness(); await h.registerPa(); });

  it('starts a conversation and replies with a ROLE_AGENT message carrying a contextId', async () => {
    const res = await h.send('What are your store hours?');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/a2a+json');
    const { message } = await res.json();
    expect(message).toMatchObject({ role: 'ROLE_AGENT', contextId: expect.any(String), parts: [{ text: 'We are open every day.' }] });
    expect(message).not.toHaveProperty('taskId');
    expect(message).not.toHaveProperty('metadata'); // no receipt without delegation
  });

  it('continues a conversation by contextId', async () => {
    const first = (await (await h.send('hello', { sub: 'u-cont' })).json()).message;
    const second = (await (await h.send('and on Sundays?', { sub: 'u-cont', contextId: first.contextId })).json()).message;
    expect(second.contextId).toBe(first.contextId);
    expect(second.messageId).not.toBe(first.messageId);
  });

  it('returns the stored reply for a repeated messageId without re-running the agent', async () => {
    const messageId = randomUUID();
    const before = h.calls.general;
    const first = (await (await h.send('hi', { sub: 'u-dup', messageId })).json()).message;
    const retry = (await (await h.send('hi', { sub: 'u-dup', messageId, contextId: first.contextId })).json()).message;
    expect(retry.messageId).toBe(first.messageId);
    expect(h.calls.general).toBe(before + 1);
  });

  it('rejects a messageId reused for a different turn in the same context', async () => {
    const first = (await (await h.send('hi', { sub: 'u-reuse' })).json()).message;
    const clash = first.messageId; // an agent message id
    await error(await h.send('again', { sub: 'u-reuse', contextId: first.contextId, messageId: clash }), { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' });
  });

  it('hides whether a context exists for someone else', async () => {
    const owner = (await (await h.send('hi', { sub: 'owner' })).json()).message;
    for (const attempt of [
      h.send('hi', { sub: 'someone-else', contextId: owner.contextId }),
      h.send('hi', { sub: 'owner', contextId: randomUUID() }),
      h.send('hi', { sub: 'owner', contextId: 'not-a-uuid' }),
    ]) {
      await error(await attempt, { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS', message: 'Unknown contextId' });
    }
  });

  it('keeps contexts separate per personal agent, even with the same sub', async () => {
    const other = await h.newAgent(); // same Provider, different personal agent
    await other.registerPa();
    const owner = (await (await h.send('hi', { sub: 'shared-sub' })).json()).message;
    expect(other.issuer).not.toBe(h.issuer);
    const res = await other.send('hi', { sub: 'shared-sub', contextId: owner.contextId });
    await error(res, { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' });
  });

  it('rejects taskId, malformed bodies, wrong role, blank text, and non-text parts', async () => {
    const msg = (m: Record<string, unknown>) => h.call(`${BRAND}/message:send`, { method: 'POST', body: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'x' }], ...m } } });
    await error(await msg({ taskId: 't-1' }), { http: 404, status: 'NOT_FOUND', reason: 'TASK_NOT_FOUND', message: 'Task not found' });
    await error(await h.call(`${BRAND}/message:send`, { method: 'POST', raw: '{' }), { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' });
    await error(await h.call(`${BRAND}/message:send`, { method: 'POST', body: {} }), { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' });
    await error(await msg({ role: 'ROLE_AGENT' }), { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' });
    await error(await msg({ parts: [{ text: '   ' }] }), { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' });
    await error(await msg({ parts: [] }), { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' });
    await error(await msg({ parts: [{ raw: 'aGVsbG8=' }] }), { http: 400, status: 'INVALID_ARGUMENT', reason: 'CONTENT_TYPE_NOT_SUPPORTED' });
    await error(await msg({ parts: [{ text: 5 }] }), { http: 400, status: 'INVALID_ARGUMENT', reason: 'INVALID_PARAMS' });
  });

  it('accepts a request whose Content-Type or A2A-Version is unusual', async () => {
    const res = await h.call(`${BRAND}/message:send`, {
      method: 'POST', headers: { 'a2a-version': '2.0' },
      body: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'hi' }] } },
    });
    expect(res.status).toBe(200);
  });

  it('survives two simultaneous first messages with the same messageId', async () => {
    const messageId = randomUUID();
    const sub = `race-${randomUUID()}`;
    const [a, b] = await Promise.all([h.send('hi', { sub, messageId }), h.send('hi', { sub, messageId })]);
    // Neither request may crash. Both start a conversation (there is no contextId to share yet),
    // so both succeed; the guarantee is that the agent's reply is stored exactly once per context.
    expect([a.status, b.status]).toEqual([200, 200]);
    const [ma, mb] = [(await a.json()).message, (await b.json()).message];
    for (const m of [ma, mb]) {
      const retry = (await (await h.send('hi', { sub, messageId, contextId: m.contextId })).json()).message;
      expect(retry.messageId).toBe(m.messageId);
    }
  });

  it('serialises two simultaneous follow-ups in one context: no lost or duplicated messages', async () => {
    const sub = `race2-${randomUUID()}`;
    const first = (await (await h.send('hi', { sub })).json()).message;
    const results = await Promise.all([
      h.send('one', { sub, contextId: first.contextId }),
      h.send('two', { sub, contextId: first.contextId }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const stored = await h.store.getMessages(first.contextId);
    expect(stored.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(stored.map((m) => m.messageId)).size).toBe(6);
  });
});

ddb('PACT Identity: registration (spec §3.1)', () => {
  it('registers a personal agent once; the same request again is idempotent', async () => {
    const h = await makeHarness();
    const name = `pa-${randomUUID().slice(0, 8)}`;
    const first = await h.registerPa(name);
    expect(first.status).toBe(201);
    expect((await first.json()).platform).toMatchObject({ name, issuer: h.issuer, jwksUri: h.jwksUri, enabled: true });
    expect((await h.registerPa(name)).status).toBe(200);
  });

  it('conflicts when the issuer or the name is taken by different details', async () => {
    const h = await makeHarness();
    await h.registerPa('pa-one-aa');
    expect((await h.registerPa('pa-two-bb')).status).toBe(409); // same issuer, different name
    const other = await h.newAgent();
    expect((await other.registerPa('pa-one-aa')).status).toBe(409); // same name, different issuer
  });

  it('rejects a registration not signed by the key it presents', async () => {
    const h = await makeHarness();
    const forger = await generateKeyPair('ES256');
    const iat = Math.floor(h.now().getTime() / 1000);
    const token = await new SignJWT({ sub: h.issuer }).setProtectedHeader({ alg: 'ES256', kid: 'pa-key-1' })
      .setIssuer(h.issuer).setAudience('https://smitty-api.test/api/platforms').setJti(randomUUID()).setIssuedAt(iat).setExpirationTime(iat + 120).sign(forger.privateKey);
    const res = await h.register(new Request('https://smitty-api.test/api/platforms', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'forged-pa', jwksUri: h.jwksUri }),
    }));
    expect(res.status).toBe(401);
  });

  it('refuses private addresses and a JWKS on another origin', async () => {
    const h = await makeHarness();
    const iat = Math.floor(h.now().getTime() / 1000);
    const sign = (iss: string) => new SignJWT({ sub: iss }).setProtectedHeader({ alg: 'ES256', kid: 'pa-key-1' })
      .setIssuer(iss).setAudience('https://smitty-api.test/api/platforms').setJti(randomUUID()).setIssuedAt(iat).setExpirationTime(iat + 120).sign(h.pa.privateKey);
    const post = async (iss: string, jwksUri: string) => h.register(new Request('https://smitty-api.test/api/platforms', {
      method: 'POST', headers: { authorization: `Bearer ${await sign(iss)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'pa-private', jwksUri }),
    }));
    for (const [iss, uri] of [
      ['https://169.254.169.254', 'https://169.254.169.254/jwks'],
      ['https://10.0.0.5', 'https://10.0.0.5/jwks'],
      ['https://localhost', 'https://localhost/jwks'],
      [h.issuer, 'https://elsewhere.example.com/jwks'],
      ['http://pa.example.com', 'http://pa.example.com/jwks'],
    ]) {
      expect((await post(iss, uri)).status).toBe(400);
    }
  });

  it('limits who may register when an allow-list is configured', async () => {
    const h = await makeHarness();
    const { createRegisterHandler } = await import('../../src/pact/provider/register');
    const guarded = createRegisterHandler({ store: h.store, baseUrl: 'https://smitty-api.test', allowedIssuers: ['https://only-this.example.com'], getJwks: h.getJwks });
    const iat = Math.floor(h.now().getTime() / 1000);
    const token = await new SignJWT({ sub: h.issuer }).setProtectedHeader({ alg: 'ES256', kid: 'pa-key-1' })
      .setIssuer(h.issuer).setAudience('https://smitty-api.test/api/platforms').setJti(randomUUID()).setIssuedAt(iat).setExpirationTime(iat + 120).sign(h.pa.privateKey);
    const res = await guarded(new Request('https://smitty-api.test/api/platforms', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'not-listed', jwksUri: h.jwksUri }),
    }));
    expect(res.status).toBe(401);
  });
});
