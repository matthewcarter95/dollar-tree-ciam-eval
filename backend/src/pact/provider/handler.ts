import { randomUUID } from 'crypto';
import { JWTVerifyGetKey } from 'jose';
import { PactBrand, PactConfig, pactUrls } from '../config';
import { AgentDeps, ChatTurn, Delegation, runAgentTurn } from './agent';
import { PlatformAuth, verifyPlatformJwt } from './auth';
import { buildAgentCard } from './card';
import { createOAuthHandler, parseScope, startDeviceAuthorization } from './oauth';
import { Conversation, PactStore, StoredMessage, TurnConflict } from './store';
import { signReceipt, verifyDelegationToken } from './tokens';

// The Provider's A2A HTTP+JSON surface (spec §2–§6). Fetch-API in, Fetch-API out, so it is
// testable without a server; provider/routes.ts adapts it to Express.

export const DELEGATION_HEADER = 'x-a2a-user-delegation';

const A2A_ERRORS = {
  INVALID_PARAMS: { httpStatus: 400, status: 'INVALID_ARGUMENT' },
  CONTENT_TYPE_NOT_SUPPORTED: { httpStatus: 400, status: 'INVALID_ARGUMENT' },
  UNSUPPORTED_OPERATION: { httpStatus: 400, status: 'FAILED_PRECONDITION' },
  PUSH_NOTIFICATION_NOT_SUPPORTED: { httpStatus: 400, status: 'FAILED_PRECONDITION' },
  TASK_NOT_FOUND: { httpStatus: 404, status: 'NOT_FOUND' },
  INTERNAL: { httpStatus: 500, status: 'INTERNAL' },
} as const;
type Reason = keyof typeof A2A_ERRORS;

class HandlerError extends Error {
  constructor(readonly reason: Reason, message: string) {
    super(message);
  }
}
const invalid = (message: string) => new HandlerError('INVALID_PARAMS', message);

function a2a(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/a2a+json' } });
}

function a2aError(reason: Reason, message: string): Response {
  const { httpStatus, status } = A2A_ERRORS[reason];
  return a2a(
    {
      error: {
        code: httpStatus,
        status,
        message,
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }],
      },
    },
    httpStatus
  );
}

const notFound = () => new Response(null, { status: 404 });

type Route =
  | { kind: 'agentCard' }
  | { kind: 'sendMessage' }
  | { kind: 'listTasks' }
  | { kind: 'taskNotFound'; id: string }
  | { kind: 'unsupported' }
  | { kind: 'pushNotificationNotSupported' };

// Spec §2.2. Routing happens before authentication.
export function matchRoute(method: string, segments: string[]): Route | null {
  const path = segments.map((s) => s.replace(/%3a/gi, ':'));
  if (method === 'GET' && path.length === 2 && path[0] === '.well-known' && path[1] === 'agent-card.json') return { kind: 'agentCard' };
  if (method === 'POST' && path.length === 1 && path[0] === 'message:send') return { kind: 'sendMessage' };
  if (method === 'POST' && path.length === 1 && path[0] === 'message:stream') return { kind: 'unsupported' };
  if (method === 'GET' && path.length === 1 && path[0] === 'tasks') return { kind: 'listTasks' };
  if (path.length === 2 && path[0] === 'tasks' && path[1]) {
    if (/^(.+):subscribe$/.test(path[1])) return method === 'POST' ? { kind: 'unsupported' } : null;
    const cancelId = path[1].match(/^(.+):cancel$/)?.[1];
    if (cancelId) return method === 'POST' ? { kind: 'taskNotFound', id: cancelId } : null;
    if (method === 'GET') return { kind: 'taskNotFound', id: path[1] };
  }
  if (path.length === 3 && path[0] === 'tasks' && path[1] && path[2] === 'pushNotificationConfigs' && (method === 'GET' || method === 'POST')) {
    return { kind: 'pushNotificationNotSupported' };
  }
  if (path.length === 4 && path[0] === 'tasks' && path[1] && path[2] === 'pushNotificationConfigs' && path[3] && (method === 'GET' || method === 'DELETE')) {
    return { kind: 'pushNotificationNotSupported' };
  }
  if (method === 'GET' && path.length === 1 && path[0] === 'extendedAgentCard') return { kind: 'unsupported' };
  return null;
}

function pageSize(url: URL): number {
  const values = url.searchParams.getAll('pageSize');
  if (values.length > 1) throw invalid('Invalid pageSize');
  const value = values[0];
  if (value === undefined) return 50;
  if (!/^\d+$/.test(value)) throw invalid('Invalid pageSize');
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw invalid('Invalid pageSize');
  return size;
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

type ParsedMessage = { messageId: string; contextId?: string; text: string; parts: unknown[] };

// Spec §4.1.
function parseMessage(raw: unknown): ParsedMessage {
  const message = (raw as { message?: Record<string, unknown> } | null)?.message;
  if (typeof raw !== 'object' || raw === null || typeof message !== 'object' || message === null) throw invalid('Invalid request body');
  const { messageId, contextId, taskId, role, parts } = message;
  if (typeof messageId !== 'string' || !messageId) throw invalid('Invalid request body');
  if (contextId !== undefined && typeof contextId !== 'string') throw invalid('Invalid request body');
  if (typeof role !== 'string') throw invalid('Invalid request body');
  if (!Array.isArray(parts) || parts.length < 1 || parts.some((p) => typeof p !== 'object' || p === null || Array.isArray(p))) {
    throw invalid('Invalid request body');
  }
  if (taskId !== undefined) throw new HandlerError('TASK_NOT_FOUND', 'Task not found');
  if (role !== 'ROLE_USER') throw invalid('Message role must be ROLE_USER');
  if (parts.some((p) => !('text' in (p as object)))) throw new HandlerError('CONTENT_TYPE_NOT_SUPPORTED', 'Content type not supported');
  if (parts.some((p) => typeof (p as { text: unknown }).text !== 'string')) throw invalid('Invalid request body');
  const text = parts.map((p) => (p as { text: string }).text).join('\n');
  if (!text.trim()) throw invalid('Message text must not be blank');
  return { messageId, ...(contextId === undefined ? {} : { contextId }), text, parts };
}

const textOf = (parts: unknown[]) =>
  parts.map((p) => (typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('\n');

const replyOf = (contextId: string, m: Pick<StoredMessage, 'messageId' | 'parts' | 'metadata'>) => ({
  message: {
    messageId: m.messageId,
    contextId,
    role: 'ROLE_AGENT',
    parts: m.parts,
    ...(m.metadata ? { metadata: m.metadata } : {}),
  },
});

export type HandlerOptions = {
  store: PactStore;
  config: PactConfig;
  deps: AgentDeps;
  getJwks?: (uri: string) => JWTVerifyGetKey;
  now?: () => Date;
};

type VerifiedDelegation = Delegation & { token: string; grantId: string; clientId: string };

export function createA2AHandler(options: HandlerOptions) {
  const { store, config } = options;
  const now = () => options.now?.() ?? new Date();
  const oauth = createOAuthHandler(options);
  const brandFor = (id: string): PactBrand | undefined => config.brands.find((b) => b.id === id);

  // Spec §5.5 (2): signature, aud, exp, client_id = PA iss, and the grant must not be revoked.
  async function verifyDelegation(header: string, auth: PlatformAuth, brand: PactBrand): Promise<VerifiedDelegation | undefined> {
    if (brand.scopes.length === 0) return undefined;
    const token = header.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return undefined;
    const urls = pactUrls(config.baseUrl, brand.id);
    try {
      const claims = await verifyDelegationToken(token, { issuer: urls.issuer, audience: urls.interfaceUrl, now: now() });
      if (claims.client_id !== auth.issuer) return undefined;
      const grant = await store.getGrant(claims.grant_id);
      if (
        !grant ||
        grant.brandId !== brand.id ||
        grant.clientId !== claims.client_id ||
        grant.brandUserId !== claims.sub ||
        grant.revokedAtMs !== undefined ||
        grant.expiresAtMs <= now().getTime()
      ) {
        return undefined;
      }
      return { token, sub: claims.sub, scopes: parseScope(claims.scope), grantId: claims.grant_id, clientId: claims.client_id };
    } catch {
      return undefined;
    }
  }

  async function sendMessage(request: Request, brand: PactBrand, auth: PlatformAuth, delegation: VerifiedDelegation | undefined) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw invalid('Invalid JSON request body');
    }
    const incoming = parseMessage(body);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await turn(brand, auth, delegation, incoming);
      } catch (err) {
        if (!(err instanceof TurnConflict)) throw err;
      }
    }
    throw invalid('The conversation is busy. Retry the same message.');
  }

  async function turn(brand: PactBrand, auth: PlatformAuth, delegation: VerifiedDelegation | undefined, incoming: ParsedMessage) {
    // Spec §4.2: a context belongs to one Brand and one (personal agent, sub); anything else is
    // INVALID_PARAMS, never "exists but isn't yours".
    let conversation: Conversation | undefined;
    if (incoming.contextId !== undefined) {
      if (!isUuid(incoming.contextId)) throw invalid('Unknown contextId');
      conversation = await store.getConversation(incoming.contextId);
      if (!conversation || conversation.brandId !== brand.id || conversation.userId !== auth.paUserId) throw invalid('Unknown contextId');
      if (delegation && conversation.brandUserId && conversation.brandUserId !== delegation.sub) {
        throw invalid('contextId already runs as a different Brand user');
      }
    }
    const history = conversation ? await store.getMessages(conversation.contextId) : [];

    // Spec §4.3: a repeated messageId returns the stored reply without re-running the agent.
    const dup = history.findIndex((m) => m.messageId === incoming.messageId && m.role === 'ROLE_USER');
    if (dup >= 0) {
      const reply = history[dup + 1];
      if (!reply || reply.role !== 'ROLE_AGENT') throw invalid('messageId was already received in this context and has no reply yet');
      return replyOf(conversation!.contextId, reply);
    }
    if (history.some((m) => m.messageId === incoming.messageId)) throw invalid('messageId is already in use in this context');

    const chat: ChatTurn[] = history.map((m) => ({ role: m.role === 'ROLE_USER' ? 'user' : 'assistant', content: textOf(m.parts) }));
    const result = await runAgentTurn({ text: incoming.text, history: chat, delegation, deps: options.deps });
    const at = now();
    const urls = pactUrls(config.baseUrl, brand.id);

    if (result.kind === 'stepUp') {
      // Spec §5.5: the turn is neither failed nor stored; the conversation stays open.
      const contextId = conversation?.contextId ?? randomUUID();
      if (!conversation) {
        await store.createConversation(
          { contextId, brandId: brand.id, userId: auth.paUserId, msgCount: 0, createdAt: at.toISOString(), updatedAt: at.toISOString() },
          at
        );
      }
      const link = await startDeviceAuthorization(store, {
        brandId: brand.id,
        urls,
        platformIssuer: auth.issuer,
        scopes: result.missingScopes,
        now: at,
      });
      if (!link) throw new HandlerError('INTERNAL', 'Internal error');
      return {
        task: {
          id: `t-${randomUUID()}`,
          contextId,
          status: {
            state: 'TASK_STATE_AUTH_REQUIRED',
            message: { messageId: randomUUID(), contextId, role: 'ROLE_AGENT', parts: [{ text: result.text }] },
          },
          metadata: {
            'pact.missingScopes': result.missingScopes,
            'pact.verificationUriComplete': link.verification_uri_complete,
          },
        },
      };
    }

    const base: Conversation = conversation ?? {
      contextId: randomUUID(),
      brandId: brand.id,
      userId: auth.paUserId,
      msgCount: 0,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    };
    const agentAt = new Date(at.getTime() + 1);
    // Spec §5.6: every reply served under a delegation token carries a signed receipt.
    const metadata = delegation
      ? {
          'pact.receipt': await signReceipt({
            grantId: delegation.grantId,
            user: delegation.sub,
            pa: delegation.clientId,
            brand: urls.interfaceUrl,
            scopesUsed: result.scopesUsed,
            actions: result.actions,
            ts: agentAt.toISOString(),
          }),
        }
      : null;
    const agent = { messageId: randomUUID(), role: 'ROLE_AGENT' as const, parts: [{ text: result.text }], metadata, createdAt: agentAt.toISOString() };
    await store.commitTurn({
      conversation: base,
      exists: conversation !== undefined,
      user: { messageId: incoming.messageId, role: 'ROLE_USER', parts: incoming.parts, createdAt: at.toISOString() },
      agent,
      ...(delegation ? { brandUserId: delegation.sub } : {}),
      now: at,
    });
    return replyOf(base.contextId, agent);
  }

  return async (request: Request, brandId: string, segments: string[]): Promise<Response> => {
    // OAuth endpoints live under /a2a/{brandId}/oauth/. Their own handlers authenticate.
    if (segments[0] === 'oauth') {
      const brand = brandFor(brandId);
      return brand ? oauth(request, brand, segments.slice(1)) : notFound();
    }

    const route = matchRoute(request.method, segments);
    if (!route) return notFound();

    if (route.kind === 'agentCard') {
      const brand = brandFor(brandId);
      if (!brand) return notFound();
      return a2a(buildAgentCard(brand, config.baseUrl), 200); // CORS is the Function URL's job
    }

    const auth = await verifyPlatformJwt({
      authorization: request.headers.get('authorization'),
      defaultAudience: config.audience,
      store,
      ...(options.getJwks ? { getJwks: options.getJwks } : {}),
      now,
    });
    if (!auth) return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="a2a"' } });

    const brand = brandFor(brandId);
    if (!brand) return notFound();

    const header = request.headers.get(DELEGATION_HEADER);
    let delegation: VerifiedDelegation | undefined;
    if (header !== null) {
      delegation = await verifyDelegation(header, auth, brand);
      if (!delegation) {
        return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="a2a", error="invalid_token"' } });
      }
    }

    try {
      if (route.kind === 'unsupported') return a2aError('UNSUPPORTED_OPERATION', 'Unsupported operation');
      if (route.kind === 'pushNotificationNotSupported') return a2aError('PUSH_NOTIFICATION_NOT_SUPPORTED', 'Push notifications are not supported');
      if (route.kind === 'taskNotFound') return a2aError('TASK_NOT_FOUND', `Task not found: ${route.id}`);
      if (route.kind === 'listTasks') {
        return a2a({ tasks: [], nextPageToken: '', pageSize: pageSize(new URL(request.url)), totalSize: 0 });
      }
      return a2a(await sendMessage(request, brand, auth, delegation));
    } catch (err) {
      if (err instanceof HandlerError) return a2aError(err.reason, err.message);
      console.error('PACT request failed', err);
      return a2aError('INTERNAL', 'Internal error');
    }
  };
}
