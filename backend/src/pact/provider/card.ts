import { PactBrand, pactUrls } from '../config';

// Spec §2.1. The JWT scheme is called `platformJwt` because the conformance suite checks that
// name; the spec's own examples say `paJwt`. The name is not normative and clients find the
// scheme by its structure.
export function buildAgentCard(brand: PactBrand, baseUrl: string) {
  const urls = pactUrls(baseUrl, brand.id);
  const delegated = brand.scopes.length > 0;
  return {
    name: brand.name,
    description: brand.description,
    supportedInterfaces: [{ url: urls.interfaceUrl, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    provider: { organization: 'Dollar Treasure', url: baseUrl },
    version: '0.1.0',
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      platformJwt: {
        httpAuthSecurityScheme: {
          scheme: 'Bearer',
          bearerFormat: 'JWT',
          description: 'JWT signed by a registered personal agent; aud is the audience assigned at registration',
        },
      },
      ...(delegated
        ? {
            userDelegation: {
              oauth2SecurityScheme: {
                description: `Act on the User's ${brand.name} account within the scopes they approve`,
                flows: {
                  deviceCode: {
                    deviceAuthorizationUrl: urls.deviceAuthorization,
                    tokenUrl: urls.token,
                    scopes: Object.fromEntries(brand.scopes.map((s) => [s.id, s.description])),
                  },
                },
                oauth2MetadataUrl: urls.metadata,
              },
            },
          }
        : {}),
    },
    // The identity-only requirement MUST stay: a personal agent may always talk with §3 alone.
    securityRequirements: [
      { schemes: { platformJwt: { list: [] } } },
      ...(delegated ? [{ schemes: { platformJwt: { list: [] }, userDelegation: { list: [] } } }] : []),
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [brand.skill],
  };
}
