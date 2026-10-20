import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { calculateJwkThumbprint, importJWK, JWK, JSONWebKeySet, KeyLike } from 'jose';

// One ES256 key signs everything this service issues: login assertions, consent sessions,
// delegation tokens and receipts. Each has its own `typ`, and every verifier pins it, so a
// token minted for one purpose is rejected for another.
//
// Lambda has no persistent disk, so the private JWK comes from an SSM SecureString
// (PACT_SIGNING_KEY_SSM_PARAMETER), or PACT_BRAND_PRIVATE_JWK for local runs.
// Rotate by publishing the new key beside the old one; verifiers refetch on an unknown kid.

export type PactKey = { privateKey: KeyLike; kid: string; publicJwk: JWK; jwks: JSONWebKeySet };

let cached: Promise<PactKey> | undefined;

export function getPactKey(): Promise<PactKey> {
  if (!cached) {
    cached = load().catch((err) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

export function resetPactKeyForTests(): void {
  cached = undefined;
}

async function readPrivateJwk(): Promise<string> {
  const parameter = process.env.PACT_SIGNING_KEY_SSM_PARAMETER;
  if (parameter) {
    const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
    const out = await ssm.send(new GetParameterCommand({ Name: parameter, WithDecryption: true }));
    if (!out.Parameter?.Value) throw new Error(`SSM parameter ${parameter} is empty`);
    return out.Parameter.Value;
  }
  const raw = process.env.PACT_BRAND_PRIVATE_JWK;
  if (!raw) throw new Error('Set PACT_SIGNING_KEY_SSM_PARAMETER (or PACT_BRAND_PRIVATE_JWK locally)');
  return raw;
}

async function load(): Promise<PactKey> {
  const jwk = JSON.parse(await readPrivateJwk()) as JWK;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
    throw new Error('PACT signing key must be a private EC P-256 JWK');
  }
  const pub: JWK = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const kid = await calculateJwkThumbprint(pub, 'sha256');
  const publicJwk: JWK = { ...pub, kid, alg: 'ES256', use: 'sig' };
  return {
    privateKey: (await importJWK(jwk, 'ES256')) as KeyLike,
    kid,
    publicJwk,
    jwks: { keys: [publicJwk] },
  };
}
