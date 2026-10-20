/**
 * Runs upstream's PACT Identity conformance suite (e2e/pact.test.ts, E2E_PROVIDER=any) against
 * THIS backend over real HTTP: the actual Express app, raw-body handling and all.
 *
 *   PACT_UPSTREAM_DIR=~/software/pact/upstream npm run conformance
 *
 * Needs Docker (DynamoDB Local) and the upstream repo checked out with `pnpm install` done.
 */
import { spawn } from 'child_process';
import { exportJWK, generateKeyPair } from 'jose';
import http from 'http';
import http2 from 'http2';
import { AddressInfo } from 'net';
import setup from '../global-setup';

const UPSTREAM = process.env.PACT_UPSTREAM_DIR;
const BRAND = '01M3R53Q5XD7T2VYB6ZC9D0HEK';
const OTHER = '01M3R53Q5XD7T2VYB6ZC9D0HEL';

async function main(): Promise<number> {
  if (!UPSTREAM) throw new Error('Set PACT_UPSTREAM_DIR to the openpactprotocol checkout');
  const teardown = await setup();
  if (!process.env.DYNAMODB_ENDPOINT) throw new Error('DynamoDB Local did not start (is Docker running?)');

  // The personal agent: a key, and a JWKS server on its own origin (its issuer).
  const pa = await generateKeyPair('ES256', { extractable: true });
  const privateJwk = { ...(await exportJWK(pa.privateKey)), kid: 'conformance-pa-1' };
  const { d: _d, ...publicJwk } = privateJwk;
  const jwksServer = http.createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: [{ ...publicJwk, alg: 'ES256', use: 'sig' }] }));
    } else res.statusCode = 404, res.end();
  });
  await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));
  const issuer = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}`;

  // A fake Bedrock Converse endpoint, so the real bedrock.ts code path runs without AWS access.
  // Dummy credentials also keep the run from ever picking up whatever AWS identity the shell has.
  // The SDK's Bedrock client speaks HTTP/2, so the fake does too (cleartext, prior knowledge).
  const bedrock = http2.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        output: { message: { role: 'assistant', content: [{ text: 'We are open every day.' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        metrics: { latencyMs: 1 },
      }));
    });
  });
  await new Promise<void>((r) => bedrock.listen(0, '127.0.0.1', r));

  const providerPort = 39101;
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: 'local',
    AWS_SECRET_ACCESS_KEY: 'local',
    AWS_SESSION_TOKEN: '',
    AWS_PROFILE: '',
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: `http://127.0.0.1:${(bedrock.address() as AddressInfo).port}`,
    PACT_ENABLED: 'true',
    PACT_BASE_URL: `http://127.0.0.1:${providerPort}`,
    PACT_BRAND_ID: BRAND,
    PACT_EXTRA_BRAND_IDS: OTHER,
    PACT_TABLE: 'pact-test',
    PACT_BRAND_PRIVATE_JWK: JSON.stringify(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    // dummy Auth0 settings: the PACT routes sit before auth(), so these are never contacted
    AUTH0_DOMAIN: 'unused.invalid', AUTH0_CLIENT_ID: 'x', AUTH0_CLIENT_SECRET: 'x', SESSION_SECRET: 'x'.repeat(32),
  });

  // Register the agent, plus a disabled one at `${issuer}/disabled-pa` (the suite expects both).
  const { createDocClient, PactStore } = await import('../../src/pact/provider/store');
  const store = new PactStore(createDocClient(), 'pact-test');
  const jwksUri = `${issuer}/.well-known/jwks.json`;
  await store.createPlatform({ name: 'conformance-pa', issuer, jwksUri });
  await store.createPlatform({ name: 'disabled-pa', issuer: `${issuer}/disabled-pa`, jwksUri });
  await store.setPlatformEnabled(`${issuer}/disabled-pa`, false);

  const { default: app } = await import('../../src/app');
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(providerPort, '127.0.0.1', r));

  // Async on purpose: this process is the Provider and the JWKS server, so blocking its event
  // loop while the suite runs would make every request time out.
  const status = await new Promise<number>((resolve) => {
    const child = spawn('npx', ['--yes', 'pnpm@11.21.0', 'e2e'], {
      cwd: UPSTREAM,
      stdio: 'inherit',
      env: {
        ...process.env,
        E2E_PROVIDER: 'any',
        PROVIDER_URL: `http://127.0.0.1:${providerPort}`,
        CUSTOMER_ID: BRAND,
        OTHER_CUSTOMER_ID: OTHER,
        PA_ISSUER: issuer,
        PA_AUDIENCE: `http://127.0.0.1:${providerPort}/a2a`,
        PA_PRIVATE_JWK: JSON.stringify(privateJwk),
      },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
  server.close();
  jwksServer.close();
  bedrock.close();
  (await teardown)?.();
  return status;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
