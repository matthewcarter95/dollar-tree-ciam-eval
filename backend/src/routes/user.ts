import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

router.get('/user', requireAuth, (req, res) => {
  const user = req.oidc?.user;
  res.json({
    sub: user?.sub,
    name: user?.name,
    email: user?.email,
    picture: user?.picture,
    loyaltyId: (user?.loyaltyId as string | number | undefined) ?? null,
  });
});

export default router;
