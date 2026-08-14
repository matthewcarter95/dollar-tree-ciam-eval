import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { getLoyaltyPoints, trackLoyaltyPoints } from '../services/loyalty';
import { getUser } from '../services/auth0-management';

const router = Router();

async function resolveLoyaltyId(req: import('express').Request): Promise<string | number | undefined> {
  const fromClaim = req.oidc?.user?.loyaltyId as string | number | undefined;
  if (fromClaim) return fromClaim;
  try {
    const auth0User = await getUser(req.oidc!.user!.sub);
    return auth0User.app_metadata?.loyaltyId as string | number | undefined;
  } catch {
    return undefined;
  }
}

// Single non-blocking CIBA poll. Called by the frontend every 3 s.
// On approval: deducts points and returns the new balance.
router.post('/purchase/poll', requireAuth, async (req, res) => {
  const { auth_req_id, itemName, pointsCost } = req.body as {
    auth_req_id?: string;
    itemName?: string;
    pointsCost?: number;
  };

  if (!auth_req_id) {
    res.status(400).json({ error: 'auth_req_id required' });
    return;
  }

  const domain = process.env.AUTH0_DOMAIN!;
  const clientId = process.env.AUTH0_CIBA_CLIENT_ID!;
  const clientSecret = process.env.AUTH0_CIBA_CLIENT_SECRET!;

  try {
    const body = new URLSearchParams({
      grant_type: 'urn:openid:params:grant-type:ciba',
      client_id: clientId,
      client_secret: clientSecret,
      auth_req_id,
    });

    const r = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (r.ok) {
      // Approved — deduct points
      const loyaltyId = await resolveLoyaltyId(req);
      let newBalance: number | undefined;
      if (loyaltyId && pointsCost && pointsCost > 0) {
        await trackLoyaltyPoints(loyaltyId, -pointsCost);
        const data = await getLoyaltyPoints(loyaltyId);
        newBalance = data.totalPoints;
      }
      res.json({ status: 'approved', newBalance, pointsDeducted: pointsCost, itemName });
      return;
    }

    const err = await r.json() as { error?: string };
    switch (err.error) {
      case 'authorization_pending': res.json({ status: 'pending' });   break;
      case 'slow_down':             res.json({ status: 'slow_down' }); break;
      case 'access_denied':         res.json({ status: 'denied' });    break;
      case 'expired_token':         res.json({ status: 'expired' });   break;
      default:
        console.error('[purchase/poll] unexpected CIBA error:', err.error);
        res.json({ status: 'error', detail: err.error });
    }
  } catch (err) {
    console.error('[purchase/poll] error:', err);
    res.status(500).json({ error: 'Poll failed' });
  }
});

export default router;
