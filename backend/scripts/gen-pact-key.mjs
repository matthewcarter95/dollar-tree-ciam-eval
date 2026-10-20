#!/usr/bin/env node
// Generates the ES256 key that signs PACT login assertions.
// Prints one line to stdout: the private JWK. Store it as PACT_BRAND_PRIVATE_JWK
// (SSM/Secrets Manager for Lambda). Never commit it.
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.stdout.write(JSON.stringify(privateKey.export({ format: 'jwk' })) + '\n');
