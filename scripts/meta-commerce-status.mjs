#!/usr/bin/env node
/**
 * Ask Meta what state the commerce app is actually in.
 *
 * Run it when you want to know whether the pieces slice 1 depends on are in place, rather than
 * inferring it from the dashboard's layout:
 *
 *   META_COMMERCE_APP_ID=... META_COMMERCE_APP_SECRET=... node scripts/meta-commerce-status.mjs
 *
 * Put the secret in the environment from a file or your shell — never on the command line, where it
 * lands in shell history and in `ps`.
 *
 * WHAT THIS CAN ANSWER. Everything below comes from Graph, so it is what Meta actually thinks:
 *   - the app exists and these credentials are really its own
 *   - what kind of app it is and what it is called
 *   - whether a webhook callback URL is registered for `whatsapp_business_account`, and which fields
 *     it is subscribed to — the plan's step 1.4, and the one most often half-done
 *
 * WHAT THIS CANNOT ANSWER, and no script can. Meta exposes no Graph endpoint for either:
 *   - Tech Provider status
 *   - App Review verdicts on `whatsapp_business_management` / `whatsapp_business_messaging` /
 *     `business_management`
 * Those live only in the App Dashboard, under App Review → Permissions and Features, and under the
 * business portfolio's verification section. A green result from this script means the plumbing is
 * right; it does not mean the app may serve real clients.
 *
 * The two credentials are read with no fallback: a probe that quietly reported on the wrong app
 * would be worse than one that refused to run.
 */

/**
 * Meta's Graph origin and the pinned version.
 *
 * Constants rather than environment overrides, unlike `config.metaCommerce` in the backend. There the
 * origin is overridable so tests can drive the connect flow against a local stand-in; here the whole
 * purpose is to ask the real Meta, and an override would only be a way to point this at something
 * else and believe the answer.
 */
const GRAPH_BASE = 'https://graph.facebook.com';
const GRAPH_VERSION = 'v21.0';

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    console.error(`✗ ${name} is not set. Export it (from a file, not inline) and run again.`);
    process.exit(1);
  }
  return value.trim();
}

const appId = required('META_COMMERCE_APP_ID');
const appSecret = required('META_COMMERCE_APP_SECRET');

/** The app access token. Meta's own format: the two credentials joined, not an OAuth exchange. */
const appToken = `${appId}|${appSecret}`;

async function graph(path, query = {}) {
  const url = new URL(`${GRAPH_BASE}/${GRAPH_VERSION}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  url.searchParams.set('access_token', appToken);

  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const body = await response.json();
  return { ok: response.ok, status: response.status, body };
}

/** Print a probe's result verbatim. Graph's own error text is more useful than any summary of it. */
function report(label, result) {
  if (result.ok) {
    console.log(`\n✓ ${label}`);
    console.log(JSON.stringify(result.body, null, 2));
    return true;
  }
  console.log(`\n✗ ${label} — HTTP ${result.status}`);
  console.log(JSON.stringify(result.body, null, 2));
  return false;
}

console.log(`Probing Meta app ${appId} against ${GRAPH_BASE}/${GRAPH_VERSION}\n${'─'.repeat(70)}`);

const identity = await graph(appId, {
  fields: 'id,name,link,category,app_type,privacy_policy_url,terms_of_service_url',
});

if (!report("App identity — the credentials are this app's own", identity)) {
  console.error(
    '\nThe app access token was rejected, so nothing below would be meaningful. Check that the ' +
      'secret belongs to THIS app id — a secret from the personal-assistant app fails exactly like ' +
      'a wrong one.',
  );
  process.exit(1);
}

report(
  'Webhook subscriptions — is /webhooks/meta registered, and for which fields',
  await graph(`${appId}/subscriptions`),
);

console.log(`\n${'─'.repeat(70)}`);
console.log('Not answerable here — check the App Dashboard directly:');
console.log('  • Tech Provider status   → business portfolio → verification');
console.log('  • App Review verdicts    → App Review → Permissions and Features');
console.log('    (whatsapp_business_management, whatsapp_business_messaging, business_management)');
console.log('  • Embedded Signup config → WhatsApp → Configuration → the config id in use');
