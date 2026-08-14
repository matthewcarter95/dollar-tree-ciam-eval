#!/usr/bin/env node
/**
 * setup-auth0-ciba.mjs
 *
 * One-time script that provisions the Auth0 resources needed for the CIBA
 * purchase-approval flow. Run after obtaining a Management API token with:
 *   create:clients  read:clients  create:resource_servers  create:client_grants
 *
 * Usage:
 *   AUTH0_MGMT_TOKEN=<token> AUTH0_DOMAIN=<domain> node scripts/setup-auth0-ciba.mjs
 *
 * Output: samconfig.toml parameter overrides to paste into the file.
 */

const DOMAIN   = process.env.AUTH0_DOMAIN   ?? 'myid-selfservice.cic-demo-platform.auth0app.com';
const TOKEN    = process.env.AUTH0_MGMT_TOKEN;
const AUDIENCE = 'https://smitty.demo-connect.us/purchases';

if (!TOKEN) {
  console.error('ERROR: AUTH0_MGMT_TOKEN is required.');
  console.error('\nTo obtain a full-scope Management API token:');
  console.error('  1. Auth0 Dashboard → Applications → APIs → Auth0 Management API');
  console.error('  2. Select the "API Explorer" tab → copy the token');
  console.error('     OR create a new M2M app and grant it all Management API scopes');
  console.error('\nRequired scopes: create:clients read:clients create:resource_servers create:client_grants');
  process.exit(1);
}

async function mgmt(method, path, body) {
  const res = await fetch(`https://${DOMAIN}/api/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok) {
    const hint = res.status === 403 && path.includes('/clients') && JSON.stringify(json).includes('ciba')
      ? '\nHINT: Enable CIBA in Auth0 Dashboard → Settings → Advanced → Client-Initiated Backchannel Authentication'
      : '';
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}${hint}`);
  }
  return json;
}

async function main() {
  console.log(`\nAuth0 CIBA setup — tenant: ${DOMAIN}\n`);

  // 1. Create resource server (API) — idempotent: skip if already exists
  let api;
  console.log('1. Creating DT Purchases API resource server...');
  try {
    api = await mgmt('POST', '/resource-servers', {
      name: 'DT Purchases API',
      identifier: AUDIENCE,
      token_lifetime: 86400,
      skip_consent_for_verifiable_first_party_clients: true,
    });
    console.log(`   Created: ${api.id} (${api.identifier})`);
  } catch (err) {
    if (String(err).includes('already')) {
      console.log('   Already exists — fetching existing...');
      const apis = await mgmt('GET', '/resource-servers');
      api = (Array.isArray(apis) ? apis : []).find(a => a.identifier === AUDIENCE);
      if (!api) throw new Error('Resource server not found after conflict error.');
      console.log(`   Found: ${api.id}`);
    } else {
      throw err;
    }
  }

  // 2. Create CIBA M2M client
  console.log('\n2. Creating DT CIBA Client application...');
  let client;
  try {
    client = await mgmt('POST', '/clients', {
      name: 'DT CIBA Client',
      app_type: 'non_interactive',
      grant_types: [
        'client_credentials',
        'urn:openid:params:grant-type:ciba',
      ],
      oidc_conformant: true,
      token_endpoint_auth_method: 'client_secret_post',
      // 'email' is the only Management API-accepted channel value.
      // Auth0 still fires a Guardian push to any enrolled device regardless;
      // this field controls the fallback notification channel.
      async_approval_notification_channels: ['email'],
    });
    console.log(`   Created: ${client.client_id}`);
  } catch (err) {
    if (String(err).includes('already')) {
      console.log('   Already exists — fetching existing...');
      const clients = await mgmt('GET', '/clients?fields=client_id,name,client_secret,grant_types&include_fields=true&per_page=100');
      client = (Array.isArray(clients) ? clients : []).find(c => c.name === 'DT CIBA Client');
      if (!client) throw new Error('Client not found after conflict error.');
      console.log(`   Found: ${client.client_id}`);
    } else {
      throw err;
    }
  }

  // 3. Create client grant (authorize CIBA client to access Purchases API)
  console.log('\n3. Creating client grant for Purchases API...');
  try {
    await mgmt('POST', '/client-grants', {
      client_id: client.client_id,
      audience: AUDIENCE,
      scope: [],
    });
    console.log('   Grant created.');
  } catch (err) {
    if (String(err).includes('already')) {
      console.log('   Grant already exists — skipping.');
    } else {
      throw err;
    }
  }

  // 4. Print samconfig.toml values
  console.log('\n─────────────────────────────────────────────────────────');
  console.log('SUCCESS. Paste these into infrastructure/samconfig.toml');
  console.log('parameter_overrides array (replacing the PENDING values):');
  console.log('─────────────────────────────────────────────────────────');
  console.log(`  "Auth0CibaClientId=${client.client_id}",`);
  console.log(`  "Auth0CibaClientSecret=${client.client_secret}",`);
  console.log(`  "Auth0CibaAudience=${AUDIENCE}"`);
  console.log('─────────────────────────────────────────────────────────\n');

  // 5. Remind about CIBA tenant setting
  console.log('IMPORTANT: Ensure CIBA is enabled on the tenant:');
  console.log('  Auth0 Dashboard → Settings → Advanced → Enable CIBA');
  console.log('  AND enable it on your Guardian / MFA policy.');
}

main().catch(err => {
  console.error('\nFATAL:', err.message ?? err);
  process.exit(1);
});
