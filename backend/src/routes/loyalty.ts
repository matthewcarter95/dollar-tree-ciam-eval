import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { getLoyaltyPoints, redeemCoupon } from '../services/loyalty';
import { getUser } from '../services/auth0-management';

const router = Router();

async function resolveLoyaltyId(
  req: import('express').Request
): Promise<string | number | undefined> {
  const fromClaim = req.oidc?.user?.loyaltyId as string | number | undefined;
  if (fromClaim) return fromClaim;
  // Fallback: loyaltyId stored in Auth0 user_metadata (set without a custom Action)
  try {
    const auth0User = await getUser(req.oidc!.user!.sub);
    return auth0User.app_metadata?.loyaltyId as string | number | undefined;
  } catch {
    return undefined;
  }
}

router.get('/loyalty', requireAuth, async (req, res) => {
  try {
    const loyaltyId = await resolveLoyaltyId(req);
    if (!loyaltyId) {
      // No loyalty account yet — return zero so the UI can display a sensible default
      res.json({ loyaltyId: null, customeridentifier: '', totalPoints: 0 });
      return;
    }
    const data = await getLoyaltyPoints(loyaltyId);
    res.json(data);
  } catch (err) {
    console.error('GET /loyalty error:', err);
    res.status(500).json({ error: 'Failed to fetch loyalty points' });
  }
});

router.post('/loyalty/redeem', requireAuth, async (req, res) => {
  const { couponCode } = req.body as { couponCode?: string };

  if (!couponCode || typeof couponCode !== 'string' || !couponCode.trim()) {
    res.status(400).json({ error: 'couponCode is required' });
    return;
  }

  const loyaltyId = await resolveLoyaltyId(req);
  if (!loyaltyId) {
    res.status(404).json({ error: 'No loyalty account linked to this user' });
    return;
  }

  try {
    const result = await redeemCoupon(loyaltyId, couponCode.trim().toUpperCase());
    res.json(result);
  } catch (err) {
    console.error('POST /loyalty/redeem error:', err);
    res.status(500).json({ error: 'Failed to redeem coupon' });
  }
});

export default router;
