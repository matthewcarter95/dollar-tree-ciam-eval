// PACT (Personal Agent Consent & Trust) configuration. This service is both the Brand
// (Dollar Treasure: Auth0 login, orders) and its own PACT Provider, so one flag turns it on.
// Off unless PACT_ENABLED is set, so existing deployments are unaffected.

export type ScopeDefinition = { id: string; description: string; detail: string };

export type PactBrand = {
  id: string;
  name: string;
  description: string;
  skill: { id: string; name: string; description: string; tags: string[]; examples: string[] };
  // Delegated authority (spec §5). Empty means the Brand serves the Identity profile only.
  scopes: ScopeDefinition[];
};

export type PactConfig = {
  // Public origin of this service. Also the `iss` of the Brand login assertion.
  baseUrl: string;
  // Opaque string assigned to personal agents; goes verbatim in the `aud` of their JWTs.
  // Must not be derived from a card URL (spec §3.1).
  audience: string;
  // Storefront, for links back from the consent flow.
  appUrl: string;
  brands: PactBrand[];
  defaultBrandId: string;
};

export const DEFAULT_BRAND_ID = '01M3R53Q5XD7T2VYB6ZC9D0HEK';

export const ORDERS_READ = 'orders:read';

export function dollarTreasure(id: string): PactBrand {
  return {
    id,
    name: 'Dollar Treasure',
    description: 'Orders and store support for Dollar Treasure.',
    skill: {
      id: 'orders',
      name: 'Orders',
      description: 'Look up your Dollar Treasure orders and their status.',
      tags: ['orders', 'order', 'purchase', 'delivery', 'status', 'store'],
      examples: ['Where is my latest order?'],
    },
    scopes: [
      {
        id: ORDERS_READ,
        description: 'View your orders and their status',
        detail: 'Order history, items, totals and delivery status',
      },
    ],
  };
}

export function pactConfig(env: NodeJS.ProcessEnv = process.env): PactConfig | null {
  if (!/^(1|true|yes|on)$/i.test(env.PACT_ENABLED ?? '')) return null;
  const baseUrl = (env.PACT_BASE_URL || `https://${env.API_HOSTNAME || 'smitty-api.demo-connect.us'}`).replace(/\/+$/, '');
  const brandId = env.PACT_BRAND_ID || DEFAULT_BRAND_ID;
  // Extra identity-only Brands (no scopes, so no delegation). Conformance runs need a second Brand
  // to prove conversations don't leak across Brands; leave unset in production.
  const extra = (env.PACT_EXTRA_BRAND_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && id !== brandId)
    .map((id): PactBrand => ({ ...dollarTreasure(id), name: `Dollar Treasure (${id})`, scopes: [] }));
  return {
    baseUrl,
    audience: env.PACT_AUDIENCE || `${baseUrl}/a2a`,
    appUrl: `https://${env.APP_HOSTNAME || 'smitty.demo-connect.us'}`,
    brands: [dollarTreasure(brandId), ...extra],
    defaultBrandId: brandId,
  };
}

export function pactUrls(baseUrl: string, brandId: string) {
  const interfaceUrl = `${baseUrl}/a2a/${brandId}`;
  const issuer = `${interfaceUrl}/oauth`;
  return {
    interfaceUrl,
    card: `${interfaceUrl}/.well-known/agent-card.json`,
    issuer,
    metadata: `${issuer}/.well-known/oauth-authorization-server`,
    jwks: `${issuer}/jwks.json`,
    deviceAuthorization: `${issuer}/device_authorization`,
    token: `${issuer}/token`,
    consent: `${issuer}/consent`,
    consentDecision: `${issuer}/consent/decision`,
    login: `${baseUrl}/pact/login`,
    connected: `${baseUrl}/pact/connected`,
  };
}
