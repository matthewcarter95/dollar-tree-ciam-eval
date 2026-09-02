/**
 * Anonymous session + cart routes.
 *
 * Anonymous sessions use Auth0's /anonymous/token endpoint (beta).
 * The access token sub looks like "anon|<uuid>".
 *
 * Cart state is stored in DynamoDB keyed by sub (works for both anonymous
 * users and authenticated users — authenticated users' sub is "auth0|xxx").
 */

import { Router } from 'express';
import * as jose from 'jose';
import {
  getCart,
  upsertCart,
  removeCartItem,
  clearCart,
} from '../services/cart-dynamodb';

const router = Router();

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN!;
const AUTH0_CANONICAL_DOMAIN = process.env.AUTH0_CANONICAL_DOMAIN!;
const CLIENT_ID = process.env.AUTH0_CLIENT_ID!;
const CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET!;
const CART_AUDIENCE = `https://${process.env.APP_HOSTNAME || 'smitty.demo-connect.us'}/cart`;

// Lazy-init JWKS verifier
let _jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
function getJwks() {
  if (!_jwks) {
    _jwks = jose.createRemoteJWKSet(
      new URL(`https://${AUTH0_DOMAIN}/.well-known/jwks.json`)
    );
  }
  return _jwks;
}

/**
 * Validate a cart access token (anonymous or authenticated).
 * Returns the sub claim, or throws if invalid.
 */
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
 * POST /api/anon/session
 *
 * Proxies to Auth0's /anonymous/token endpoint. The client_secret stays on
 * the server so it is never exposed to the browser.
 *
 * Body: { session_token?: string }
 * Response: { access_token, session_token, expires_in }
 */
router.post('/anon/session', async (req, res) => {
  try {
    const { session_token } = req.body as { session_token?: string };

    const body: Record<string, string> = {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      audience: CART_AUDIENCE,
      scope: 'cart:write',
    };
    if (session_token) {
      body.session_token = session_token;
    }

    const response = await fetch(
      `https://${AUTH0_CANONICAL_DOMAIN}/anonymous/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

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

/**
 * GET /api/cart
 * Returns the current cart for the bearer token's subject.
 */
router.get('/cart', async (req, res) => {
  try {
    const sub = await validateCartToken(req.headers.authorization);
    const cart = await getCart(sub);
    res.json(cart);
  } catch (err: any) {
    if (err.status === 401) {
      res.status(401).json({ error: err.message });
    } else {
      console.error('[cart] GET error:', err);
      res.status(500).json({ error: 'Failed to read cart' });
    }
  }
});

/**
 * POST /api/cart
 * Adds or increments an item in the cart.
 *
 * Body: { name: string, emoji: string, price: string, pointsCost: number }
 */
router.post('/cart', async (req, res) => {
  try {
    const sub = await validateCartToken(req.headers.authorization);
    const { name, emoji, price, pointsCost } = req.body as {
      name?: string;
      emoji?: string;
      price?: string;
      pointsCost?: number;
    };

    if (!name || !price) {
      res.status(400).json({ error: 'name and price are required' });
      return;
    }

    const cart = await upsertCart(sub, {
      name: name.trim(),
      emoji: emoji ?? '🛍️',
      price: price.trim(),
      pointsCost: Number(pointsCost ?? 0),
    });
    res.json(cart);
  } catch (err: any) {
    if (err.status === 401) {
      res.status(401).json({ error: err.message });
    } else {
      console.error('[cart] POST error:', err);
      res.status(500).json({ error: 'Failed to add to cart' });
    }
  }
});

/**
 * DELETE /api/cart/:name
 * Decrements or removes an item from the cart.
 */
router.delete('/cart/:name', async (req, res) => {
  try {
    const sub = await validateCartToken(req.headers.authorization);
    const { name } = req.params;
    const cart = await removeCartItem(sub, decodeURIComponent(name));
    res.json(cart);
  } catch (err: any) {
    if (err.status === 401) {
      res.status(401).json({ error: err.message });
    } else {
      console.error('[cart] DELETE error:', err);
      res.status(500).json({ error: 'Failed to remove from cart' });
    }
  }
});

/**
 * DELETE /api/cart
 * Clears the entire cart.
 */
router.delete('/cart', async (req, res) => {
  try {
    const sub = await validateCartToken(req.headers.authorization);
    await clearCart(sub);
    res.json({ items: [] });
  } catch (err: any) {
    if (err.status === 401) {
      res.status(401).json({ error: err.message });
    } else {
      console.error('[cart] DELETE all error:', err);
      res.status(500).json({ error: 'Failed to clear cart' });
    }
  }
});

export default router;
