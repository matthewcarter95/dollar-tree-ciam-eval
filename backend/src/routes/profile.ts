import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { requireAuth } from '../middleware/requireAuth';
import {
  getUser,
  updateUser,
  listMfaFactors,
  deleteMfaFactor,
  createGuardianEnrollmentTicket,
  associateTotpFactor,
  confirmTotpFactor,
} from '../services/auth0-management';
import { toStateAbbr } from '../utils/usStates';

const router = Router();

type PaymentMethod = {
  id: string; brand: string; last4: string; expMonth: number; expYear: number;
  name: string; isDefault: boolean; number?: string;
};

const publicMethod = ({ number: _n, ...rest }: PaymentMethod) => rest;


// GET /api/profile — merged Auth0 user + oidc claims
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const user = req.oidc!.user!;
    const auth0User = await getUser(user.sub);
    const meta = (auth0User.user_metadata ?? {}) as Record<string, unknown>;
    res.json({
      sub: user.sub,
      name: auth0User.name,
      email: auth0User.email,
      // Phone stored in user_metadata to avoid Auth0's E.164 format restriction
      // on the top-level phone_number field (reserved for SMS MFA).
      phone: (meta.phone as string) ?? '',
      picture: user.picture,
      loyaltyId: user.loyaltyId ?? (auth0User.app_metadata?.loyaltyId as string | number) ?? null,
      loyaltyPoints: user.loyaltyPoints ?? null,
      user_metadata: {
        ...meta,
        ...(Array.isArray(meta.payment_methods)
          ? { payment_methods: (meta.payment_methods as PaymentMethod[]).map(publicMethod) }
          : {}),
      },
    });
  } catch (err) {
    console.error('GET /profile error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// PATCH /api/profile — update name and/or phone (phone stored in user_metadata)
router.patch('/profile', requireAuth, async (req, res) => {
  const { name, phone } = req.body as { name?: string; phone?: string };

  if (name === undefined && phone === undefined) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }

  try {
    const userId = req.oidc!.user!.sub;
    // Fetch current user to merge user_metadata (avoid clobbering existing keys)
    const current = await getUser(userId);
    const currentMeta = (current.user_metadata ?? {}) as Record<string, unknown>;

    const patch: { name?: string; user_metadata?: Record<string, unknown> } = {};
    if (name !== undefined) patch.name = name.trim();
    if (phone !== undefined) {
      patch.user_metadata = { ...currentMeta, phone: phone.trim() };
    }

    await updateUser(userId, patch);
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ----- Addresses (stored in user_metadata.addresses) -----

router.get('/profile/addresses', requireAuth, async (req, res) => {
  try {
    const auth0User = await getUser(req.oidc!.user!.sub);
    const addresses = (auth0User.user_metadata?.addresses as unknown[]) ?? [];
    res.json(addresses);
  } catch (err) {
    console.error('GET /profile/addresses error:', err);
    res.status(500).json({ error: 'Failed to load addresses' });
  }
});

router.post('/profile/addresses', requireAuth, async (req, res) => {
  const { label, street, city, state, zip, country } = req.body as {
    label?: string; street: string; city: string;
    state: string; zip: string; country: string;
  };
  if (!street || !city || !state || !zip || !country) {
    res.status(400).json({ error: 'street, city, state, zip, country are required' });
    return;
  }
  const stateAbbr = country.toUpperCase() === 'US' ? toStateAbbr(state) : state.trim();
  if (!stateAbbr) {
    res.status(400).json({ error: 'state must be a valid US state name or 2-letter abbreviation' });
    return;
  }
  try {
    const auth0User = await getUser(req.oidc!.user!.sub);
    const existing = (auth0User.user_metadata?.addresses as unknown[]) ?? [];
    const newAddress = { id: uuidv4(), label: label ?? 'Address', street, city, state: stateAbbr, zip, country };
    await updateUser(req.oidc!.user!.sub, {
      user_metadata: { ...(auth0User.user_metadata ?? {}), addresses: [...existing, newAddress] },
    });
    res.status(201).json(newAddress);
  } catch (err) {
    console.error('POST /profile/addresses error:', err);
    res.status(500).json({ error: 'Failed to add address' });
  }
});

router.delete('/profile/addresses/:id', requireAuth, async (req, res) => {
  try {
    const auth0User = await getUser(req.oidc!.user!.sub);
    const existing = (auth0User.user_metadata?.addresses as Array<{ id: string }>) ?? [];
    const filtered = existing.filter((a) => a.id !== req.params.id);
    await updateUser(req.oidc!.user!.sub, {
      user_metadata: { ...(auth0User.user_metadata ?? {}), addresses: filtered },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /profile/addresses error:', err);
    res.status(500).json({ error: 'Failed to delete address' });
  }
});

// ----- Mock payment methods (stored in user_metadata.payment_methods) -----
// DEMO ONLY (test card numbers, never real cards): the full number is stored in
// user_metadata so a UCP client can replay it as a `card` credential. The CVV is
// never persisted (UCP does not check it). The number is stripped from every API
// response to the browser.


function cardBrand(num: string): string {
  if (/^4/.test(num)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(num)) return 'Mastercard';
  if (/^3[47]/.test(num)) return 'American Express';
  if (/^(6011|65)/.test(num)) return 'Discover';
  return 'Card';
}

router.get('/profile/payment-methods', requireAuth, async (req, res) => {
  try {
    const auth0User = await getUser(req.oidc!.user!.sub);
    res.json(((auth0User.user_metadata?.payment_methods as PaymentMethod[]) ?? []).map(publicMethod));
  } catch (err) {
    console.error('GET /profile/payment-methods error:', err);
    res.status(500).json({ error: 'Failed to load payment methods' });
  }
});

router.post('/profile/payment-methods', requireAuth, async (req, res) => {
  const { name, number, expMonth, expYear, cvv } = req.body as {
    name?: string; number?: string; expMonth?: number | string; expYear?: number | string; cvv?: string;
  };
  const digits = (number ?? '').replace(/[\s-]/g, '');
  const month = Number(expMonth);
  let year = Number(expYear);
  if (year < 100) year += 2000;
  if (!name?.trim() || !/^\d{13,19}$/.test(digits) || !/^\d{3,4}$/.test(cvv ?? '')) {
    res.status(400).json({ error: 'name, a 13-19 digit card number, and a 3-4 digit cvv are required' });
    return;
  }
  if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) {
    res.status(400).json({ error: 'Invalid expiry date' });
    return;
  }
  const now = new Date();
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
    res.status(400).json({ error: 'Card is expired' });
    return;
  }
  try {
    const sub = req.oidc!.user!.sub;
    const auth0User = await getUser(sub);
    const existing = (auth0User.user_metadata?.payment_methods as PaymentMethod[]) ?? [];
    const method: PaymentMethod = {
      id: uuidv4(), brand: cardBrand(digits), last4: digits.slice(-4),
      expMonth: month, expYear: year, name: name.trim(), isDefault: existing.length === 0, number: digits,
    };
    await updateUser(sub, {
      user_metadata: { ...(auth0User.user_metadata ?? {}), payment_methods: [...existing, method] },
    });
    res.status(201).json(publicMethod(method));
  } catch (err) {
    console.error('POST /profile/payment-methods error:', err);
    res.status(500).json({ error: 'Failed to add payment method' });
  }
});

router.delete('/profile/payment-methods/:id', requireAuth, async (req, res) => {
  try {
    const sub = req.oidc!.user!.sub;
    const auth0User = await getUser(sub);
    const existing = (auth0User.user_metadata?.payment_methods as PaymentMethod[]) ?? [];
    const filtered = existing.filter((m) => m.id !== req.params.id);
    if (filtered.length && !filtered.some((m) => m.isDefault)) filtered[0].isDefault = true;
    await updateUser(sub, {
      user_metadata: { ...(auth0User.user_metadata ?? {}), payment_methods: filtered },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /profile/payment-methods error:', err);
    res.status(500).json({ error: 'Failed to delete payment method' });
  }
});

// ----- MFA Factors -----

router.get('/profile/mfa', requireAuth, async (req, res) => {
  try {
    const methods = await listMfaFactors(req.oidc!.user!.sub);
    res.json(methods);
  } catch (err) {
    console.error('GET /profile/mfa error:', err);
    res.status(500).json({ error: 'Failed to load MFA factors' });
  }
});

router.delete('/profile/mfa/:methodId', requireAuth, async (req, res) => {
  try {
    await deleteMfaFactor(req.oidc!.user!.sub, req.params.methodId);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /profile/mfa error:', err);
    res.status(500).json({ error: 'Failed to delete MFA factor' });
  }
});

// POST /api/profile/mfa/enroll — MyAccount API TOTP enrollment.
// The access token (audience = https://{domain}/me/, scope = create:me:authentication_methods)
// is stored in the OIDC session from login and used directly here — no refresh-token
// exchange needed. Returns a QR code data URL for inline display.
router.post('/profile/mfa/enroll', requireAuth, async (req, res) => {
  try {
    const oidc = (req as any).oidc;

    // The login access_token is opaque (no audience). For MyAccount API calls we
    // exchange the refresh_token for a JWT scoped to https://{domain}/me/ with
    // create:me:authentication_methods — this works because the DT Chatbot client
    // has a client grant for the MyAccount resource server.
    const refreshToken: string | undefined = oidc?.refreshToken;
    if (!refreshToken) {
      res.status(403).json({
        error: 'Session missing refresh token. Please sign out and back in.',
        code: 'ENROLL_SCOPE_MISSING',
      });
      return;
    }

    const tokenRes = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: process.env.AUTH0_CLIENT_ID,
        client_secret: process.env.AUTH0_CLIENT_SECRET,
        refresh_token: refreshToken,
        audience: `https://${process.env.AUTH0_DOMAIN}/me/`,
        scope: 'create:me:authentication_methods',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('MyAccount token exchange failed:', err);
      res.status(403).json({
        error: 'Could not obtain MyAccount token for MFA enrollment. Please sign out and back in.',
        code: 'ENROLL_SCOPE_MISSING',
      });
      return;
    }

    const tokenData = await tokenRes.json() as { access_token?: string; scope?: string; error?: string; error_description?: string };
    console.log('[MFA enroll] token exchange — scope:', tokenData.scope, '| prefix:', tokenData.access_token?.substring(0, 20));
    const myAccountToken = tokenData.access_token;
    if (!myAccountToken) {
      console.error('[MFA enroll] no access_token in exchange response:', JSON.stringify(tokenData));
      res.status(403).json({ error: 'Token exchange did not return an access token.', code: 'ENROLL_SCOPE_MISSING' });
      return;
    }
    const enrollment = await associateTotpFactor(myAccountToken);

    // Build QR code — use barcodeUri if Auth0 returned it, otherwise build from secret
    const qrSource = enrollment.barcodeUri || enrollment.secret;
    const qrCodeDataUrl = qrSource
      ? await QRCode.toDataURL(qrSource, { width: 220 })
      : '';

    res.json({
      enrollmentId: enrollment.id,
      authSession: enrollment.authSession,
      secret: enrollment.secret,
      barcodeUri: enrollment.barcodeUri,
      qrCodeDataUrl,
      recoveryCodes: enrollment.recoveryCodes ?? [],
    });
  } catch (err) {
    const code = (err as any)?.code;
    if (code === 'ENROLL_SCOPE_MISSING') {
      res.status(403).json({
        error: 'Your session does not have MFA enrollment permissions. Please sign out and sign back in.',
        code: 'ENROLL_SCOPE_MISSING',
      });
      return;
    }
    console.error('POST /profile/mfa/enroll error:', err);
    res.status(500).json({ error: 'Failed to initiate MFA enrollment' });
  }
});

// POST /api/profile/mfa/confirm — verify the first OTP code to confirm a pending enrollment.
// Auth0 creates TOTP factors with confirmed: false; a PATCH with the OTP code confirms them.
router.post('/profile/mfa/confirm', requireAuth, async (req, res) => {
  const { enrollmentId, authSession } = req.body as { enrollmentId?: string; authSession?: string };
  if (!enrollmentId || !authSession) {
    res.status(400).json({ error: 'enrollmentId and authSession are required' });
    return;
  }

  try {
    const refreshToken: string | undefined = (req as any).oidc?.refreshToken;
    if (!refreshToken) {
      res.status(403).json({ error: 'Session missing refresh token. Please sign out and back in.', code: 'ENROLL_SCOPE_MISSING' });
      return;
    }

    const tokenRes = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: process.env.AUTH0_CLIENT_ID,
        client_secret: process.env.AUTH0_CLIENT_SECRET,
        refresh_token: refreshToken,
        audience: `https://${process.env.AUTH0_DOMAIN}/me/`,
        scope: 'create:me:authentication_methods',
      }),
    });

    if (!tokenRes.ok) {
      console.error('MyAccount token exchange (confirm) failed:', await tokenRes.text());
      res.status(403).json({ error: 'Could not obtain token for MFA confirmation. Please sign out and back in.', code: 'ENROLL_SCOPE_MISSING' });
      return;
    }

    const { access_token } = await tokenRes.json() as { access_token?: string };
    if (!access_token) {
      res.status(403).json({ error: 'Token exchange did not return an access token.', code: 'ENROLL_SCOPE_MISSING' });
      return;
    }

    await confirmTotpFactor(enrollmentId, authSession, access_token);
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.code === 'INVALID_OTP') {
      res.status(422).json({ error: 'Incorrect code — please try again.', code: 'INVALID_OTP' });
      return;
    }
    if (err?.code === 'ENROLL_SCOPE_MISSING') {
      res.status(403).json({ error: 'Insufficient permissions. Please sign out and back in.', code: 'ENROLL_SCOPE_MISSING' });
      return;
    }
    console.error('POST /profile/mfa/confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm MFA enrollment' });
  }
});

export default router;
