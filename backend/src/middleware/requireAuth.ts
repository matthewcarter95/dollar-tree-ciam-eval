import { Request, Response, NextFunction } from 'express';
import { getSessionBySessionId } from '../services/dynamodb-sessions';

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.oidc?.isAuthenticated()) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Check if session was revoked via backchannel logout
  const sessionId = (req.session as any)?.id;
  if (sessionId) {
    const dbSession = await getSessionBySessionId(sessionId);
    if (dbSession?.revoked) {
      req.session.destroy(() => {});
      res.status(401).json({ error: 'Session revoked' });
      return;
    }
  }

  next();
}
