// Boots the local stack the commerce e2e specs run against, and tears it down again.
//
// WHY A LOCAL STACK, when every other spec in this package drives production:
// the commerce plane is not deployed yet, so there is nothing at www.stewra.com to drive. Just as
// important, connecting a channel means completing Meta's Embedded Signup against a real WhatsApp
// Business Account owned by a real business — not something a test may do to production, ever. So
// this suite runs the REAL backend and the REAL website against the test database, with only Meta
// itself replaced, at the network boundary, by `graphStub.mjs`.
//
// Nothing here is guessed. The database and secrets come from `backend/.env.test` — the same file
// the backend's own Vitest suite uses — and a missing one throws rather than being defaulted into a
// run that quietly targets the wrong machine. The Meta app credentials are minted fresh per run:
// they only have to match between this stack and its own Graph stub, and a literal in the repo
// would be a credential-shaped string that outlives the run.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startGraphStub } from './graphStub.mjs';
import { startMailSink } from './mailSink.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const BACKEND = join(REPO, 'backend');
const WEBSITE = join(REPO, 'website');

/** How long to wait for each server to answer before calling the boot failed. */
const READY_TIMEOUT_MS = 90_000;

/** Reads `backend/.env.test` into a plain object. The stack has no other source of truth. */
function readBackendTestEnv() {
  const path = join(BACKEND, '.env.test');
  if (!existsSync(path)) {
    throw new Error(
      `[commerce-e2e] ${path} does not exist. The commerce suite runs against the test database, ` +
        'and that file is where its connection lives. Copy backend/.env.test.example and fill it in.',
    );
  }
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') out[key] = value;
  }
  return out;
}

function requireValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[commerce-e2e] backend/.env.test is missing ${name}.`);
  }
  return value;
}

/** Asks the OS for a port nothing is listening on. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Polls `url` until it answers, or gives up loudly with whatever the last failure was. */
async function waitForHttp(url, label, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    if (child !== undefined && child.exitCode !== null) {
      throw new Error(
        `[commerce-e2e] ${label} exited with code ${child.exitCode} before it was ready. ` +
          'Its output is above.',
      );
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `[commerce-e2e] ${label} was not ready at ${url} within ${READY_TIMEOUT_MS}ms (last: ${lastError}).`,
  );
}

/** Pipes a child's output through, tagged, so a boot failure is diagnosable rather than silent. */
function tag(child, label) {
  const write = (stream) => (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() !== '') stream.write(`  [${label}] ${line}\n`);
    }
  };
  child.stdout.on('data', write(process.stdout));
  child.stderr.on('data', write(process.stderr));
}

/**
 * Registers a QA user through the real API, then marks it verified directly in the database.
 *
 * The verification email cannot be read here (that path needs the mail-server access the sign-up
 * spec gates on), and every commerce route sits behind the email-verification gate. Flipping the
 * one column is the smallest honest shortcut: the account, its password hash and its tokens are
 * all real and minted by the real endpoints.
 */
async function createVerifiedUser(apiUrl, databaseUrl, { email, password }) {
  const res = await fetch(`${apiUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // A business signup — this user's orgs are created by name in the specs, and an individual org
    // would refuse the invites the tenancy specs send.
    body: JSON.stringify({
      email,
      password,
      displayName: 'Commerce QA',
      accountKind: 'business',
      companyName: 'Commerce QA Ltd',
    }),
  });
  const payload = await res.json();
  if (!payload.success) {
    throw new Error(`[commerce-e2e] could not register the QA user: ${JSON.stringify(payload)}`);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const updated = await client.query('UPDATE users SET email_verified = true WHERE email = $1', [
      email,
    ]);
    if (updated.rowCount !== 1) {
      throw new Error(
        `[commerce-e2e] registered ${email} but could not mark it verified — ` +
          `${updated.rowCount} rows matched. Is the API pointed at the same database as this script?`,
      );
    }
  } finally {
    await client.end();
  }

  return { email, password };
}

/**
 * Starts Graph stub → backend → website, in that order, and resolves with everything the specs
 * need. Every step is awaited to readiness, so a spec never races the boot.
 */
/**
 * The Stripe half of the billing config, or `null` when this checkout has no test keys.
 *
 * There is no stand-in option here, and that is the whole point. `STRIPE_API_BASE_URL` can redirect
 * the SERVER's calls, but the card number is typed into an iframe served by js.stripe.com and
 * confirmed by Stripe's own script against the publishable key — a browser cannot be pointed
 * somewhere else, and a fake key is rejected before the field renders. So the only honest way to
 * drive card entry through the UI is Stripe's real test mode, and without keys that leg does not
 * run at all rather than running against something that is not Stripe.
 *
 * All three keys or none: a publishable key with no secret renders a card field whose confirmation
 * the server cannot verify, which fails halfway through with a message about the wrong thing.
 */
function readStripeConfig(backendEnv) {
  const names = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'];
  const present = names.filter((name) => {
    const value = backendEnv[name];
    return typeof value === 'string' && value !== '';
  });
  if (present.length === 0) return null;
  if (present.length !== names.length) {
    const missing = names.filter((name) => !present.includes(name));
    throw new Error(
      `[commerce-e2e] backend/.env.test sets ${present.join(', ')} but not ${missing.join(', ')}. ` +
        'Stripe needs all three or none — a partial set boots a card form that cannot be confirmed.',
    );
  }
  // Test mode is not a preference here. These specs put cards on file and charge invoices; a live
  // key would move real money on a real account, and the prefix is the only thing that tells them
  // apart before the first charge.
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY']) {
    if (!backendEnv[name].includes('_test_')) {
      throw new Error(
        `[commerce-e2e] ${name} in backend/.env.test is not a test-mode key. This suite charges ` +
          'invoices; refusing to run it against live Stripe.',
      );
    }
  }
  return {
    COMMERCE_BILLING_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: backendEnv['STRIPE_SECRET_KEY'],
    STRIPE_PUBLISHABLE_KEY: backendEnv['STRIPE_PUBLISHABLE_KEY'],
    STRIPE_WEBHOOK_SECRET: backendEnv['STRIPE_WEBHOOK_SECRET'],
  };
}

export async function startCommerceStack() {
  const backendEnv = readBackendTestEnv();
  const databaseUrl = requireValue(backendEnv['DATABASE_URL'], 'DATABASE_URL');
  const stripe = readStripeConfig(backendEnv);

  // Meta-shaped ids, so a log line reads like the real thing. The two SECRETS are random per run.
  const appId = '100000000000001';
  const configId = '200000000000002';
  const appSecret = randomBytes(16).toString('hex');
  const verifyToken = randomBytes(16).toString('hex');

  const graph = await startGraphStub({ appId, appSecret });
  const mail = await startMailSink();

  // Minted BEFORE the backend boots, because the address goes into its environment twice over: the
  // QA account is also this install's platform operator (INSTALL_ADMIN_EMAILS below), and that list
  // is read once at startup.
  const stamp = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const qaUser = {
    email: `qa-commerce+${stamp}@stewra.test`,
    password: `Qa!${stamp}A1`,
  };

  const apiPort = await freePort();
  const webPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;

  const backend = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      ...backendEnv,
      PORT: String(apiPort),
      // CORS origin and post-OAuth redirect. Must be the site this run actually serves.
      WEB_APP_URL: webUrl,
      META_COMMERCE_ENABLED: 'true',
      META_COMMERCE_APP_ID: appId,
      META_COMMERCE_APP_SECRET: appSecret,
      META_COMMERCE_CONFIG_ID: configId,
      META_COMMERCE_VERIFY_TOKEN: verifyToken,
      META_COMMERCE_GRAPH_BASE_URL: graph.origin,
      // The org-invite email leaves through the backend's real SMTP transport, and a failed
      // delivery revokes the invite by design — so the stack provides a real listener rather than
      // letting every invite die against whatever `.env.test` points at. See mailSink.mjs.
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(mail.port),
      // The QA account doubles as the install's platform operator. Rate cards and spend caps are
      // granted from `/platform/*` — surfaces that belong to whoever carries the Meta bill, with no
      // org-facing UI — and without them every billable send is refused, which would leave the
      // broadcast and template-send paths permanently untestable. Overrides `.env.test`'s list: its
      // fixture addresses have no registered accounts in this stack anyway.
      INSTALL_ADMIN_EMAILS: qaUser.email,
      // The suite waits on real queue progress (imports, broadcast dispatch and send). The default
      // 5s poll is tuned for production patience, not for a test that sits inside a 120s budget
      // with three queue hops in it.
      COMMERCE_WORKER_POLL_MS: '500',
      // Billing sweeps hourly in production. The billing spec subscribes an org and then waits for
      // the REAL scheduler to close its period, issue the invoice and collect it — an hour of which
      // no test may sit through. Two seconds, and the sweep's own idempotency does the rest.
      COMMERCE_BILLING_SWEEP_MS: '2000',
      // Spread last so an unset Stripe leaves `.env.test`'s own value alone — with no keys the
      // backend boots on the `manual` provider, which is a real, shippable configuration and the
      // one every credential-free billing assertion runs against.
      ...(stripe ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tag(backend, 'api');
  await waitForHttp(`${apiUrl}/health`, 'backend', backend);

  const user = await createVerifiedUser(apiUrl, databaseUrl, qaUser);

  const website = spawn(
    'npx',
    ['vite', '--port', String(webPort), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: WEBSITE,
      env: { ...process.env, VITE_API_BASE_URL: apiUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  tag(website, 'web');
  await waitForHttp(webUrl, 'website', website);

  return {
    webUrl,
    apiUrl,
    graphOrigin: graph.origin,
    // Which billing provider the stack actually booted on. Published so a spec asserts against the
    // configuration that is running rather than guessing from whether a locator appeared.
    billingProvider: stripe === null ? 'manual' : 'stripe',
    // The test database, published for the same class of setup `createVerifiedUser` already does
    // here: a fact no endpoint can establish and no browser can reach. Billing in advance only
    // bills a subscription that was already in force when the month began, so a run on any day but
    // the 1st has to backdate one to see an invoice at all.
    databaseUrl,
    // Published so a spec can sign an inbound webhook exactly as Meta does. Signing it for real is
    // the only way to prove the signature gate lets genuine traffic through.
    appSecret,
    user,
    async stop() {
      website.kill('SIGTERM');
      backend.kill('SIGTERM');
      await graph.close();
      await mail.close();
    },
  };
}
