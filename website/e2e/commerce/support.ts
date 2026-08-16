// Shared plumbing for the commerce specs — the same helpers `commerce.spec.ts` opens with, lifted
// out so the audience/campaigns/team files do not each carry a private copy that can drift.
//
// Everything here is either a read of what the global setup published, or setup a browser cannot
// perform (the Meta code exchange that stands in for Embedded Signup, a signed webhook delivery,
// the platform-operator grants). The features under test are driven through the page, never from
// here.
import { createHmac, randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * Published by `globalSetup.mjs` once the stack is up. Never defaulted: a guessed port would drive
 * whatever else happened to be listening and report the result as this feature's behaviour.
 */
export function fromStack(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `[commerce-e2e] ${name} is not set. These specs only run under playwright.commerce.config.ts, ` +
        'whose global setup boots the stack and publishes its addresses.',
    );
  }
  return value;
}

export const WEB = fromStack('COMMERCE_E2E_WEB_URL');
export const API = fromStack('COMMERCE_E2E_API_URL');
export const GRAPH = fromStack('COMMERCE_E2E_GRAPH_URL');

/** Points the Graph stand-in at the shape of account this test needs Meta to report. */
export async function setGraphState(patch: {
  wabaId?: string;
  phoneStatus?: string;
  pin?: string;
  templateStatus?: string;
}): Promise<void> {
  const res = await fetch(`${GRAPH}/__stub/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`[commerce-e2e] graph stub refused a state change: HTTP ${res.status}`);
  }
}

export async function graphCalls(): Promise<ReadonlyArray<{ method: string; pathname: string }>> {
  const res = await fetch(`${GRAPH}/__stub/state`);
  const body: { calls: Array<{ method: string; pathname: string }> } = await res.json();
  return body.calls;
}

/**
 * One login for the whole worker. A login per test would trip the backend's per-IP rate limiter and
 * fail the run for a reason that has nothing to do with commerce.
 */
let cachedTokens: { accessToken: string; refreshToken: string } | null = null;

export async function tokens(): Promise<{ accessToken: string; refreshToken: string }> {
  if (cachedTokens !== null) {
    return cachedTokens;
  }
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: fromStack('COMMERCE_E2E_EMAIL'),
      password: fromStack('COMMERCE_E2E_PASSWORD'),
    }),
  });
  const payload: { data?: { tokens?: { accessToken: string; refreshToken: string } } } =
    await res.json();
  const minted = payload.data?.tokens;
  if (minted === undefined) {
    throw new Error(`[commerce-e2e] could not log the QA user in: ${JSON.stringify(payload)}`);
  }
  cachedTokens = minted;
  return minted;
}

/**
 * An authenticated call to the real API, for the setup a browser cannot perform. The caller names
 * the response shape it is about to read; anything it does not read stays untyped.
 */
export async function apiCall<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T; raw: string }> {
  const auth = await tokens();
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${auth.accessToken}`,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const raw = await res.text();
  const body: T = JSON.parse(raw);
  return { status: res.status, body, raw };
}

/**
 * Delivers an inbound WhatsApp message the way Meta does: a POST to the public webhook, signed
 * with the app secret over the exact bytes sent.
 *
 * The signature is computed here rather than bypassed because the gate is the security boundary —
 * a test that skipped it would leave the one middleware standing between the internet and every
 * tenant's inbox completely unexercised.
 */
export async function deliverInbound(params: {
  orgId: string;
  wabaId: string;
  from: string;
  text: string;
}): Promise<string> {
  const providerMessageId = `wamid.IN${randomUUID()}`;
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: params.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550100100', phone_number_id: 'phone-e2e-1' },
              contacts: [{ profile: { name: 'Dana Customer' }, wa_id: params.from }],
              messages: [
                {
                  from: params.from,
                  id: providerMessageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: params.text },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const signature = createHmac('sha256', fromStack('COMMERCE_E2E_APP_SECRET'))
    .update(body)
    .digest('hex');

  const res = await fetch(`${API}/webhooks/meta`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${signature}`,
    },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`[commerce-e2e] the webhook refused a correctly signed delivery: ${res.status}`);
  }

  // The webhook acks BEFORE it processes — Meta retries anything slow, so the endpoint answers
  // first and stores after. Loading the page on the 200 alone is therefore a race, and one that
  // resolves differently depending on how busy the machine is. Wait for the message to actually
  // land, the way the product's own reader would.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const listed = await apiCall<{
      data: { conversations: Array<{ lastMessagePreview: string }> };
    }>(`/orgs/${params.orgId}/conversations?limit=30`);
    const { conversations } = listed.body.data;
    if (conversations.some((c) => c.lastMessagePreview.includes(params.text.slice(0, 20)))) {
      return providerMessageId;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `[commerce-e2e] the webhook acked "${params.text}" but it never reached the inbox within 20s.`,
  );
}

/** Creates an organization through the UI and waits for it to become the selected one. */
export async function createOrg(page: Page, name: string): Promise<string> {
  await page.getByPlaceholder('New organization name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(`Created ${name}. You are its owner.`)).toBeVisible();
  await expect(
    page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Connected numbers' }) }),
  ).toBeVisible();

  const orgs = await apiCall<{
    data: { memberships: Array<{ org: { id: string; name: string } }> };
  }>('/orgs');
  const created = orgs.body.data.memberships.find((m) => m.org.name === name);
  if (created === undefined) {
    throw new Error(`[commerce-e2e] created "${name}" in the UI but the API does not list it`);
  }
  return created.org.id;
}

/**
 * Opens a commerce page ON the given org, through the page's own org picker.
 *
 * Selected per page rather than by marking the org ACTIVE: the active org is persistent, cross-test
 * state on the QA user, and `commerce.spec.ts` reloads mid-test assuming none exists (its pages
 * fall back to the newest membership). A spec that set one would silently repoint every later
 * reload in the run at its own leftover tenant.
 *
 * `ready` is something that only renders once an org's sections are on screen — it doubles as the
 * signal that the membership list has settled, so the picker's presence can be tested rather than
 * raced. With a single membership no picker renders, and none is needed: the sole org is the
 * newest, which is the fallback the page already applies.
 */
export async function openOrgPage(
  page: Page,
  path: string,
  orgId: string,
  ready: Locator,
): Promise<void> {
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  // Options read `${name} · ${role}`, and no other select on any commerce page contains the
  // dot-separated role suffix — the member-role selects hold bare role words.
  const picker = page.locator('select').filter({ hasText: '· owner' });
  // Whichever renders first proves the org list has loaded: the picker (two or more memberships)
  // or the target content itself (one membership, already the right org).
  await expect(picker.or(ready).first()).toBeVisible();
  if ((await picker.count()) > 0) {
    await picker.selectOption(orgId);
  }
  await expect(ready).toBeVisible();
}

/**
 * Completes a connection through the real API.
 *
 * The browser half — Meta's Embedded Signup dialog — cannot be driven from a test, so the code it
 * would return is handed to the same endpoint the page posts to. Everything downstream of that
 * code is the real thing: the token exchange, `debug_token`, the phone read, the webhook
 * subscription and the vault write all happen against the running backend.
 */
export async function connectChannel(orgId: string, code: string, pin?: string): Promise<void> {
  const res = await apiCall(`/orgs/${orgId}/channels/whatsapp`, {
    method: 'POST',
    body: { code, ...(pin === undefined ? {} : { pin }) },
  });
  if (res.status !== 201) {
    throw new Error(`[commerce-e2e] connect failed (${res.status}): ${res.raw}`);
  }
}

/**
 * The platform operator's half of making a send billable: a USD rate card covering calling code 1
 * for both categories these specs send, and spend headroom for the org.
 *
 * Called through the real `/platform/*` routes as the QA user, whom the stack names in
 * `INSTALL_ADMIN_EMAILS` — these are operator surfaces with no page behind them, which is exactly
 * the "setup a browser cannot perform" case `apiCall` exists for. Without both grants the backend
 * refuses every template send as unpriceable spend, by design.
 *
 * Loaded per call rather than once: rate cards are install-global and the latest effective card
 * wins, so every load carries the full set of rates any commerce spec needs — a card that listed
 * only its own spec's category would silently unprice the other file's sends.
 */
export async function grantPricingAndHeadroom(orgId: string): Promise<void> {
  const card = await apiCall('/platform/rate-cards', {
    method: 'POST',
    body: {
      currency: 'USD',
      effectiveFrom: new Date().toISOString(),
      sourceNote: 'commerce e2e: fixture card covering +1 for marketing and utility sends',
      rates: [
        {
          countryCallingCode: '1',
          pricingCategory: 'marketing',
          amountMicros: '25000',
          unit: 'per_message',
        },
        {
          countryCallingCode: '1',
          pricingCategory: 'utility',
          amountMicros: '4000',
          unit: 'per_message',
        },
      ],
    },
  });
  if (card.status !== 201) {
    throw new Error(`[commerce-e2e] rate card load failed (${card.status}): ${card.raw}`);
  }

  const cap = await apiCall('/platform/spend-caps', {
    method: 'PUT',
    body: {
      orgId,
      currency: 'USD',
      // 100 USD in micros — far above what a test sends, so the cap grants without ever binding.
      // The cap-refusal path has its own backend tests; here it must not fire by accident.
      limitMicros: '100000000',
      note: 'commerce e2e: headroom so billable sends are priced, not refused',
    },
  });
  if (cap.status !== 200) {
    throw new Error(`[commerce-e2e] spend cap grant failed (${cap.status}): ${cap.raw}`);
  }
}

/** Which provider the stack booted billing on. Published by the global setup, never guessed. */
export const BILLING_PROVIDER = fromStack('COMMERCE_E2E_BILLING_PROVIDER');

/**
 * The one plan the billing specs subscribe orgs to, created once per worker.
 *
 * A fresh name per run rather than a fixture, because plan versions are append-only: reusing a name
 * across runs would climb the version number forever and make "Version 1" an assertion that passes
 * exactly once. Install-admin surface, so it goes through `/platform/*` — a client may never write
 * the price it is billed at, which is the whole reason these routes are separate.
 */
let cachedPlan: { id: string; name: string } | null = null;

export async function billingPlan(): Promise<{ id: string; name: string }> {
  if (cachedPlan !== null) return cachedPlan;
  const name = `Stewra Pro e2e ${randomUUID().slice(0, 8)}`;
  const created = await apiCall<{ data: { plan: { id: string; name: string } } }>(
    '/platform/billing/plans',
    {
      method: 'PUT',
      body: {
        name,
        // $149.00 in micros — what the website lists. The stores list $213, which is this figure
        // grossed up for the headline 30% commission so the net is the same in every channel.
        platformFeeMicros: '149000000',
        currency: 'USD',
        note: 'commerce e2e: the plan the billing page is asserted against',
      },
    },
  );
  const plan = created.body.data.plan;
  cachedPlan = plan;
  return plan;
}

/** Puts an org on a plan, naming who collects. Install-admin surface; no page writes this. */
export async function subscribeOrg(params: {
  orgId: string;
  planId: string;
  collector: 'stewra_stripe' | 'apple' | 'google';
}): Promise<void> {
  const res = await apiCall(`/platform/billing/subscriptions`, {
    method: 'PUT',
    body: {
      orgId: params.orgId,
      planId: params.planId,
      collector: params.collector,
      note: `commerce e2e: collected by ${params.collector}`,
    },
  });
  if (res.status !== 200) {
    throw new Error(`[commerce-e2e] subscribe failed (${res.status}): ${res.raw}`);
  }
}

/**
 * Moves a subscription's start back to before the current month began.
 *
 * Setup, not the feature. The platform fee is charged IN ADVANCE, which means a period only bills a
 * subscription that was already in force when the month started — an org subscribed on the 16th is
 * free until the 1st, by design and with its own backend test. So on any day but the 1st there is
 * no invoice to see, and a browser suite that wanted to watch one issue and be charged would have
 * to wait for a calendar month.
 *
 * One column, on a row this test created seconds ago, in the test database. Everything downstream —
 * the sweep, the close job, the invoice, the charge — then runs for real. The same shape of
 * shortcut, and the same justification, as flipping `email_verified` in `stack.mjs`.
 *
 * The period marker goes with it, and that is not an extra liberty — it is the same edit finished.
 * The sweep runs every two seconds in this stack, so between subscribing and backdating it can
 * already have closed the current period, correctly producing no invoice for a subscription that
 * did not exist when the month began. That marker is derived from facts this function is changing,
 * and `periodsNeedingClose` never revisits a closed period, so leaving it behind means the org is
 * never billed and the test fails with a timeout that blames the wrong thing. Both statements run
 * in one transaction so no sweep can observe a backdated subscription against a stale marker.
 */
export async function backdateSubscription(orgId: string): Promise<void> {
  const client = new pg.Client({ connectionString: fromStack('COMMERCE_E2E_DATABASE_URL') });
  await client.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE commerce_subscriptions
          SET started_at = date_trunc('month', now() AT TIME ZONE 'utc') - interval '1 day'
        WHERE org_id = $1 AND ended_at IS NULL`,
      [orgId],
    );
    if (updated.rowCount !== 1) {
      throw new Error(
        `[commerce-e2e] expected exactly one live subscription for org ${orgId} to backdate, ` +
          `found ${updated.rowCount}.`,
      );
    }
    await client.query(
      `DELETE FROM commerce_billing_periods
        WHERE org_id = $1
          AND period_start = date_trunc('month', now() AT TIME ZONE 'utc')::date`,
      [orgId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Waits until the billing page has actually answered, before anything asserts what it says.
 *
 * Needed because every empty state on this page is also its INITIAL state: `subscription` starts
 * null ("not on a plan yet"), `invoices` starts `[]` ("No invoices yet"), `paymentMethod` starts
 * null (no card section at all). A test that asserted any of those the moment the page mounted
 * would pass against a request that had not been made yet, and would keep passing after the
 * endpoint behind it broke — the exact shape of a test that looks green and covers nothing.
 *
 * `Loading…` is the one element tied to the fetch itself: it is cleared in the `finally` of the
 * billing load, so its absence is the page saying the round trip is over.
 */
export async function billingLoaded(page: Page): Promise<void> {
  await expect(page.getByText('Loading…')).toBeHidden();
}

/**
 * Reloads the billing page until `wanted` appears on it, or gives up loudly.
 *
 * The billing sweep is a real background timer, so a page rendered one second after a subscription
 * is created is honestly showing no invoice yet — the only way to see one is to look again. Looking
 * through the PAGE rather than the API is the point: the invoice has to survive the whole round
 * trip into the list a customer reads, not merely exist in a table.
 *
 * Each attempt WAITS on the locator rather than sampling it. The Plan card that `openOrgPage` waits
 * for renders on mount, before `GET /billing` has answered — it says "not on a plan yet" until the
 * data lands — so an instant count after it appears reads an empty list every single time, and the
 * loop spins to its deadline against a page that had the invoice on it all along. (It did. That is
 * why this is written the long way.)
 */
export async function reloadBillingUntil(
  page: Page,
  orgId: string,
  ready: Locator,
  wanted: Locator,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    await openOrgPage(page, '/commerce/billing', orgId, ready);
    try {
      await expect(wanted).toBeVisible({ timeout: 3_000 });
      return;
    } catch {
      // Not there yet. The next sweep is seconds away; reload and look again.
    }
  }
  throw new Error(
    `[commerce-e2e] billing never showed ${what} for org ${orgId} within 60s (${attempts} reloads).`,
  );
}
