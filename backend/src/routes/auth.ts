import { Router } from 'express';
import * as jose from 'jose';
import { revokeSessionsBySid, revokeSessionsByUserId } from '../services/dynamodb-sessions';

// Workaround: express-openid-connect restricts returnTo to same origin as baseURL.
// Since baseURL is the API domain, the post-login redirect would land on the API.
// By disabling routes.login and handling it here, we explicitly set returnTo to
// the frontend app hostname so the browser ends up at the React UI after login.

const router = Router();

function setAnonSessionCookie(res: any, sessionToken: string) {
  // SameSite=Lax is sent on top-level GET navigations (cross-site redirects),
  // which is exactly what the login redirect to Auth0's /authorize endpoint is.
  res.cookie('auth0_anon', sessionToken, {
    secure: true,
    sameSite: 'lax',
    domain: '.demo-connect.us',
    maxAge: 5 * 60 * 1000,
  });
}

router.get('/login', (req, res) => {
  const APP_HOSTNAME = process.env.APP_HOSTNAME || 'smitty.demo-connect.us';
  const { session_token } = req.query as { session_token?: string };
  if (session_token) {
    setAnonSessionCookie(res, session_token);
  }
  (res as any).oidc.login({
    returnTo: `https://${APP_HOSTNAME}`,
    // Pass as /authorize URL parameter too — belt-and-suspenders in case
    // the cookie is dropped during the redirect.
    ...(session_token ? { authorizationParams: { anonymous_session_token: session_token } } : {}),
  });
});

// Signup route — opens Universal Login directly on the signup screen.
router.get('/signup', (req, res) => {
  const APP_HOSTNAME = process.env.APP_HOSTNAME || 'smitty.demo-connect.us';
  const { session_token } = req.query as { session_token?: string };
  if (session_token) {
    setAnonSessionCookie(res, session_token);
  }
  (res as any).oidc.login({
    returnTo: `https://${APP_HOSTNAME}`,
    authorizationParams: {
      screen_hint: 'signup',
      ...(session_token ? { anonymous_session_token: session_token } : {}),
    },
  });
});

/**
 * OIDC Backchannel Logout endpoint.
 *
 * Auth0 calls this when a user logs out of another session (single sign-out).
 * We validate the logout_token JWT, find any active sessions, and revoke them.
 * The frontend polls /api/user; when it gets 401, it re-challenges the user.
 *
 * Register this URL in Auth0 tenant: Applications > App > Advanced > Backchannel Logout URI
 *   https://smitty-api.demo-connect.us/auth/backchannel-logout
 */
router.post('/backchannel-logout', async (req, res) => {
  const logoutToken: string | undefined = req.body?.logout_token;

  if (!logoutToken) {
    res.status(400).send('Missing logout_token');
    return;
  }

  try {
    const JWKS = jose.createRemoteJWKSet(
      new URL(`https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`)
    );

    const { payload } = await jose.jwtVerify(logoutToken, JWKS, {
      issuer: `https://${process.env.AUTH0_DOMAIN}/`,
      audience: process.env.AUTH0_CLIENT_ID,
    });

    // Validate this is a logout token (not an ID token)
    if (!payload.events || !(payload.events as any)['http://schemas.openid.net/event/backchannel-logout']) {
      res.status(400).send('Invalid logout token: missing events claim');
      return;
    }
    if (payload.nonce !== undefined) {
      res.status(400).send('Invalid logout token: nonce claim must not be present');
      return;
    }

    const sid = payload.sid as string | undefined;
    const sub = payload.sub as string | undefined;

    if (sid) {
      await revokeSessionsBySid(sid);
    } else if (sub) {
      await revokeSessionsByUserId(sub);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Backchannel logout error:', err);
    // Return 400 so Auth0 knows the token was invalid; 200 to suppress retries
    res.status(400).send('Invalid logout token');
  }
});

export default router;
