/**
 * Anonymous session + cart routes.
 *
 * Cart sub resolution priority:
 *   1. Authenticated OIDC session (req.oidc.user.sub) — used after login
 *   2. Anonymous Bearer token — used for unauthenticated browsing
 *
 * This means the same routes serve both anonymous and authenticated users.
 * The Post-Login Action merges the anonymous cart into the authenticated
 * user's cart in DynamoDB, so when the user lands back on the page the
 * GET /api/cart call (now using their OIDC sub) returns the merged cart.
 */

import { Router, Request } from 'express';
import * as jose from 'jose';
import {
  getCart,
  upsertCart,
  upsertCartBulk,
  removeCartItem,
  clearCart,
} from '../services/cart-dynamodb';

const router = Router();

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN!;

const CLIENT_ID = process.env.AUTH0_CLIENT_ID!;
const CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET!;
const CART_AUDIENCE = `https://${process.env.APP_HOSTNAME || 'smitty.demo-connect.us'}/cart`;
const CART_MERGE_SECRET = process.env.CART_MERGE_SECRET!;


let _jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
function getJwks() {
  if (!_jwks) {
    _jwks = jose.createRemoteJWKSet(
      new URL(`https://${AUTH0_DOMAIN}/.well-known/jwks.json`)
    );
  }
  return _jwks;
}

async function validateCartToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) {
    throw Object.assign(new Error('Missing token'), { status: 401 });
  }
  const token = authHeader.slice(7);
  const { payload } = await jose.jwtVerify(token, getJwks(), {
    issuer: `https://${AUTH0_DOMAIN}/`,
    audience: CART_AUDIENCE,
  });
  const sub = payload.sub;
  if (!sub) throw Object.assign(new Error('No sub claim'), { status: 401 });
  return sub;
}

/**
 * Resolve the cart owner's sub.
 * Prefer the authenticated OIDC session so logged-in users see their
 * merged cart; fall back to the anonymous Bearer token.
 */
async function resolveCartSub(req: Request): Promise<string> {
  const oidc = (req as any).oidc;
  if (oidc?.isAuthenticated?.()) return oidc.user.sub as string;
  return validateCartToken(req.headers.authorization);
}

// ---------------------------------------------------------------------------
// POST /api/anon/session
// ---------------------------------------------------------------------------
router.post('/anon/session', async (req, res) => {
  try {
    const { session_token } = req.body as { session_token?: string };

    const body: Record<string, string> = {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      audience: CART_AUDIENCE,
      scope: 'cart:write',
    };
    if (session_token) body.session_token = session_token;

    const response = await fetch(`https://${AUTH0_DOMAIN}/anonymous/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      console.error('[anon] /anonymous/token error:', data);
      res.status(response.status).json(data);
      return;
    }

    res.json({
      access_token: data.access_token,
      session_token: data.session_token,
      expires_in: data.expires_in,
      token_type: data.token_type ?? 'Bearer',
    });
  } catch (err) {
    console.error('[anon] session error:', err);
    res.status(500).json({ error: 'Failed to obtain anonymous session' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cart/merge  (called by Auth0 Post-Login Action)
//
// Merges the anonymous cart into the authenticated user's cart, then deletes
// the anonymous cart.  Protected by a shared secret so only the Action can
// call it.
// ---------------------------------------------------------------------------
router.post('/cart/merge', async (req, res) => {
  const oidc = (req as any).oidc;
  const fromAction = req.headers['x-action-secret'] === CART_MERGE_SECRET;
  const fromBrowser = oidc?.isAuthenticated?.();

  if (!fromAction && !fromBrowser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { anonSub } = req.body as { anonSub?: string; authenticatedSub?: string };
  // Action passes authenticatedSub explicitly; browser call derives it from OIDC session
  const authenticatedSub: string | undefined =
    (req.body as any).authenticatedSub ?? (fromBrowser ? oidc.user.sub : undefined);

  if (!anonSub || !authenticatedSub) {
    res.status(400).json({ error: 'anonSub and authenticatedSub are required' });
    return;
  }

  // Sanity: only allow merging from an anonymous sub
  if (!anonSub.startsWith('anon@')) {
    res.status(400).json({ error: 'anonSub must be an anonymous identity' });
    return;
  }

  try {
    const [anonCart, authCart] = await Promise.all([
      getCart(anonSub),
      getCart(authenticatedSub),
    ]);

    if (anonCart.items.length === 0) {
      res.json({ merged: 0, authenticatedSub });
      return;
    }

    // Merge: start from the authenticated user's existing cart, fold in anon items
    const merged = [...authCart.items];
    for (const item of anonCart.items) {
      const idx = merged.findIndex(i => i.name === item.name);
      if (idx >= 0) {
        merged[idx] = { ...merged[idx], qty: merged[idx].qty + item.qty };
      } else {
        merged.push(item);
      }
    }

    await Promise.all([
      upsertCartBulk(authenticatedSub, merged),
      clearCart(anonSub),
    ]);

    console.log(`[cart/merge] ${anonSub} → ${authenticatedSub}: ${anonCart.items.length} item type(s) merged`);
    res.json({ merged: merged.length, authenticatedSub });
  } catch (err) {
    console.error('[cart/merge] error:', err);
    res.status(500).json({ error: 'Cart merge failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/cart
// ---------------------------------------------------------------------------
router.get('/cart', async (req, res) => {
  try {
    const sub = await resolveCartSub(req);
    res.json(await getCart(sub));
  } catch (err: any) {
    if (err.status === 401) res.status(401).json({ error: err.message });
    else { console.error('[cart] GET error:', err); res.status(500).json({ error: 'Failed to read cart' }); }
  }
});

// ---------------------------------------------------------------------------
// POST /api/cart
// ---------------------------------------------------------------------------
router.post('/cart', async (req, res) => {
  try {
    const sub = await resolveCartSub(req);
    const { name, emoji, price, pointsCost } = req.body as {
      name?: string; emoji?: string; price?: string; pointsCost?: number;
    };
    if (!name || !price) { res.status(400).json({ error: 'name and price are required' }); return; }
    res.json(await upsertCart(sub, {
      name: name.trim(), emoji: emoji ?? '🛍️', price: price.trim(), pointsCost: Number(pointsCost ?? 0),
    }));
  } catch (err: any) {
    if (err.status === 401) res.status(401).json({ error: err.message });
    else { console.error('[cart] POST error:', err); res.status(500).json({ error: 'Failed to add to cart' }); }
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/cart/:name
// ---------------------------------------------------------------------------
router.delete('/cart/:name', async (req, res) => {
  try {
    const sub = await resolveCartSub(req);
    res.json(await removeCartItem(sub, decodeURIComponent(req.params.name)));
  } catch (err: any) {
    if (err.status === 401) res.status(401).json({ error: err.message });
    else { console.error('[cart] DELETE error:', err); res.status(500).json({ error: 'Failed to remove from cart' }); }
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/cart
// ---------------------------------------------------------------------------
router.delete('/cart', async (req, res) => {
  try {
    const sub = await resolveCartSub(req);
    await clearCart(sub);
    res.json({ items: [] });
  } catch (err: any) {
    if (err.status === 401) res.status(401).json({ error: err.message });
    else { console.error('[cart] DELETE all error:', err); res.status(500).json({ error: 'Failed to clear cart' }); }
  }
});

export default router;
