import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { auth } from 'express-openid-connect';
import { recordSession } from './services/dynamodb-sessions';
import { v4 as uuidv4 } from 'uuid';

import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import userRoutes from './routes/user';
import profileRoutes from './routes/profile';
import loyaltyRoutes from './routes/loyalty';
import purchaseRoutes from './routes/purchase';

const app = express();

const API_HOSTNAME = process.env.API_HOSTNAME || 'smitty-api.demo-connect.us';
const APP_HOSTNAME = process.env.APP_HOSTNAME || 'smitty.demo-connect.us';

app.set('trust proxy', 1);

// CORS is handled entirely by the Lambda Function URL configuration.
// Lambda Function URL intercepts OPTIONS preflight requests at the infrastructure
// level (they never reach Express), and adds Access-Control-Allow-* headers to
// all matching cross-origin responses. Adding cors() here as well causes duplicate
// Access-Control-Allow-Origin headers which browsers reject.
// See: CLAUDE.md — "Lambda Function URL handles CORS"

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Auth0 redirect flow — sessions stored in encrypted cookies scoped to .demo-connect.us
// Refresh Token Rotation: DISABLED (required for Token Vault / federated token exchange)
app.use(
  auth({
    authRequired: false,
    auth0Logout: true,
    secret: process.env.SESSION_SECRET!,
    baseURL: `https://${API_HOSTNAME}`,
    clientID: process.env.AUTH0_CLIENT_ID!,
    clientSecret: process.env.AUTH0_CLIENT_SECRET!,
    issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
    authorizationParams: {
      response_type: 'code',
      // audience=/me/ is required so the refresh_token is bound to the MyAccount API
      // audience from the start. Without it, the RT is bound to /userinfo and Auth0
      // silently ignores any audience upgrade in a subsequent refresh_token grant.
      // With this set, req.oidc.user is populated from the id_token (not /userinfo) —
      // all standard OIDC claims (sub, name, email, picture) are still present.
      audience: `https://${process.env.AUTH0_DOMAIN}/me/`,
      scope: 'openid profile email offline_access read:me:authentication_methods create:me:authentication_methods update:me:authentication_methods delete:me:authentication_methods',
      // Route users directly to a specific Auth0 connection.
      // Set AUTH0_CONNECTION to a connection name or connection ID.
      // Leave unset to show the universal login with all connections.
      ...(process.env.AUTH0_CONNECTION ? { connection: process.env.AUTH0_CONNECTION } : {}),
    },
    session: {
      absoluteDuration: 86400,
      rolling: false,
      cookie: {
        // Shared across smitty.demo-connect.us and smitty-api.demo-connect.us
        domain: '.demo-connect.us',
        sameSite: 'None',
        secure: true,
      },
    },
    routes: {
      callback: '/auth/callback',
      login: false,   // handled in auth router with explicit returnTo → frontend
      logout: '/auth/logout',
      postLogoutRedirect: `https://${APP_HOSTNAME}`,
    },
    afterCallback: async (_req, _res, session) => {
      // The session passed here is a plain serialized TokenSet (no .claims() method,
      // no .user property). sub lives inside id_token; sid is a top-level field.
      const s = session as any;
      let sub: string | undefined;
      const sid: string = s.sid ?? '';

      if (s.id_token) {
        try {
          const payload = JSON.parse(
            Buffer.from(s.id_token.split('.')[1], 'base64url').toString('utf8')
          );
          sub = payload.sub;
        } catch {
          // id_token malformed — skip session recording
        }
      }

      if (sub) {
        await recordSession({
          sessionId: uuidv4(),
          userId: sub,
          sid,
          revoked: false,
          createdAt: new Date().toISOString(),
        });
      }
      return session;
    },
  })
);

app.use('/auth', authRoutes);
app.use('/api', userRoutes);
app.use('/api', profileRoutes);
app.use('/api', loyaltyRoutes);
app.use('/api', purchaseRoutes);
app.use('/api', chatRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

export default app;
