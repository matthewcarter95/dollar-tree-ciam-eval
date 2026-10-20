import express, { Request, Response, Router } from 'express';
import { consentTarget, signAssertion } from './assertion';
import { PactConfig, pactConfig, pactUrls } from './config';
import { createAgentDeps } from './provider/deps';
import { createA2AHandler } from './provider/handler';
import { createRegisterHandler } from './provider/register';
import { createDocClient, PactStore } from './provider/store';
import { esc } from './provider/pages';

// PACT surface of the Dollar Treasure backend. It is the Brand (Auth0 login, orders) and its
// own Provider (Agent Card, A2A, OAuth, consent). Everything here is a no-op unless PACT_ENABLED.

export const cfg: PactConfig | null = pactConfig();

function toFetchRequest(config: PactConfig, req: Request): globalThis.Request {
  // The origin comes from configuration, never from the Host header, so a spoofed Host cannot
  // change the issuer or audience we compute.
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
  return new globalThis.Request(`${config.baseUrl}${req.originalUrl}`, {
    method: req.method,
    headers,
    ...(hasBody ? { body: new Uint8Array(req.body as Buffer) } : {}),
  });
}

async function send(res: Response, out: globalThis.Response): Promise<void> {
  res.status(out.status);
  out.headers.forEach((value, name) => res.setHeader(name, value));
  res.send(Buffer.from(await out.arrayBuffer()));
}

/**
 * Provider routes: /a2a/* and /api/platforms. Mounted BEFORE express.json(): the spec has
 * malformed JSON and any Content-Type reach the handler (and get an A2A error), so the body
 * must arrive raw.
 */
export function createProviderRouter(config: PactConfig | null = cfg): Router {
  const router = Router();
  if (!config) return router;

  if (!process.env.PACT_TABLE) throw new Error('PACT_ENABLED is set but PACT_TABLE is not (the DynamoDB table for the Provider)');
  const store = new PactStore(createDocClient(), process.env.PACT_TABLE);
  const a2a = createA2AHandler({ store, config, deps: createAgentDeps() });
  const register = createRegisterHandler({
    store,
    baseUrl: config.baseUrl,
    allowedIssuers: (process.env.PACT_ALLOWED_ISSUERS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  });
  const raw = express.raw({ type: () => true, limit: '256kb' });

  router.post('/api/platforms', raw, async (req, res) => {
    try {
      await send(res, await register(toFetchRequest(config, req)));
    } catch (err) {
      console.error('PACT registration error', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.all('/a2a/:brandId/*', raw, async (req, res) => {
    try {
      const segments = (req.params as Record<string, string>)[0].split('/').filter(Boolean);
      await send(res, await a2a(toFetchRequest(config, req), req.params.brandId, segments));
    } catch (err) {
      console.error('PACT provider error', err);
      res.status(500).end();
    }
  });
  return router;
}

function page(res: Response, status: number, title: string, body: string, opts: { nonce?: string; formAction?: string } = {}) {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        opts.nonce ? `script-src 'nonce-${opts.nonce}'` : "script-src 'none'",
        `form-action ${opts.formAction ?? "'none'"}`,
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    })
    .send(
      `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
        `<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">${body}</body>`
    );
}

/** Brand routes: login, post-consent landing, discovery. Mounted AFTER auth() so req.oidc exists. */
export function createBrandRouter(config: PactConfig | null = cfg): Router {
  const router = Router();
  if (!config) return router;

  const consentUrls = config.brands.filter((b) => b.scopes.length > 0).map((b) => pactUrls(config.baseUrl, b.id).consent);

  // Spec §5.3: the Provider sends the User here; we log them in with Auth0 (the existing
  // session), then POST a signed single-use assertion to the consent page.
  router.get('/pact/login', async (req: Request, res: Response) => {
    const returnTo = req.query.return_to;
    const target = consentTarget(consentUrls, returnTo);
    if (!target) {
      page(res, 400, 'Unknown sign-in request', '<h1>Unknown sign-in request</h1><p>Start again from your agent.</p>');
      return;
    }
    if (!req.oidc?.isAuthenticated()) {
      // returnTo must be same-origin as baseURL (express-openid-connect), so it is a relative path.
      (res as any).oidc.login({ returnTo: `/pact/login?return_to=${encodeURIComponent(returnTo as string)}` });
      return;
    }
    const user = req.oidc.user as { sub?: string; email?: string; email_verified?: boolean; name?: string } | undefined;
    if (!user?.sub || !user.email) {
      page(res, 400, 'Account problem', '<h1>We need an email on your account</h1><p>Add one to your profile and try again.</p>');
      return;
    }
    if (user.email_verified === false) {
      page(res, 403, 'Verify your email', '<h1>Verify your email first</h1><p>Confirm your email address, then start again from your agent.</p>');
      return;
    }
    try {
      const assertion = await signAssertion({
        iss: config.baseUrl,
        aud: target.consentUrl,
        sub: user.sub,
        email: user.email,
        name: user.name,
        userCode: target.userCode,
      });
      const { randomBytes } = await import('crypto');
      const nonce = randomBytes(16).toString('base64');
      page(
        res,
        200,
        'Signing in…',
        `<form method="post" action="${esc(target.consentUrl)}">` +
          `<input type="hidden" name="assertion" value="${esc(assertion)}">` +
          `<p>Signed in as <b>${esc(user.email)}</b>. Continuing…</p>` +
          `<noscript><button type="submit">Continue</button></noscript></form>` +
          `<script nonce="${nonce}">document.forms[0].submit()</script>`,
        { nonce, formAction: new URL(target.consentUrl).origin }
      );
    } catch (err) {
      console.error('PACT assertion signing failed:', err);
      page(res, 500, 'Error', '<h1>Something went wrong</h1><p>Start again from your agent.</p>');
    }
  });

  // Where the consent page sends the User. Display only: the grant exists or it doesn't, and
  // nothing here is trusted. Scope labels come from our own config, so unknown ids are shown as-is.
  router.get('/pact/connected', (req: Request, res: Response) => {
    const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : '');
    const client = esc(q('client').slice(0, 80) || 'Your personal agent');
    const link = `<p><a href="${esc(config.appUrl)}">Back to the store</a></p>`;
    if (q('status') !== 'approved') {
      page(res, 200, 'Not connected', `<h1>Not connected</h1><p>${client} was not given access to your account.</p>${link}`);
      return;
    }
    const labels = new Map(config.brands.flatMap((b) => b.scopes.map((s) => [s.id, s.description] as const)));
    const items = q('scope')
      .split(' ')
      .filter(Boolean)
      .map((s) => `<li>${esc(labels.get(s) ?? s)}</li>`)
      .join('');
    page(
      res,
      200,
      'Connected',
      `<h1>${client} is connected</h1><p>It can now:</p><ul>${items}</ul>` +
        `<p>You can return to your agent. To remove access, disconnect it from your agent's settings.</p>${link}`
    );
  });

  // Spec §2.1: the standard discovery location serves the card or redirects to the Provider.
  router.get('/.well-known/agent-card.json', (_req, res) => {
    res.redirect(302, pactUrls(config.baseUrl, config.defaultBrandId).card);
  });
  return router;
}
