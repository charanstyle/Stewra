// The commerce plane, driven through the real website in a real browser.
//
// WHAT IS REAL HERE: the browser, the page, the API client, the Express backend, its routers and
// middleware, Postgres, the vault, the webhook signature gate, and the HMAC this file computes to
// get past it. WHAT IS NOT: Meta, whose Graph host is a separate stand-in process
// (`graphStub.mjs`) that the backend really calls over a real socket.
//
// Meta is the one thing a test cannot have. Connecting for real means authorizing a live WhatsApp
// Business Account belonging to an actual business, and receiving for real means a real customer
// sending a real message. Everything between those two edges runs exactly as it does in production.
//
// NOT COVERED HERE: Meta's Embedded Signup dialog, which is a browser dialog served from
// facebook.com. Driving it would mean intercepting a request inside the browser and serving a fake
// SDK, which is a stand-in for our own dependency rather than a real system — see README.md.
import { createHmac, randomUUID } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Published by `globalSetup.mjs` once the stack is up. Never defaulted: a guessed port would drive
 * whatever else happened to be listening and report the result as this feature's behaviour.
 */
function fromStack(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `[commerce-e2e] ${name} is not set. These specs only run under playwright.commerce.config.ts, ` +
        'whose global setup boots the stack and publishes its addresses.',
    );
  }
  return value;
}

const WEB = fromStack('COMMERCE_E2E_WEB_URL');
const API = fromStack('COMMERCE_E2E_API_URL');
const GRAPH = fromStack('COMMERCE_E2E_GRAPH_URL');

/** Points the Graph stand-in at the shape of account this test needs Meta to report. */
async function setGraphState(patch: {
  wabaId?: string;
  phoneStatus?: string;
  pin?: string;
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

async function graphCalls(): Promise<ReadonlyArray<{ method: string; pathname: string }>> {
  const res = await fetch(`${GRAPH}/__stub/state`);
  const body = (await res.json()) as { calls: Array<{ method: string; pathname: string }> };
  return body.calls;
}

/**
 * One login for the whole file. A login per test would trip the backend's per-IP rate limiter and
 * fail the run for a reason that has nothing to do with commerce.
 */
let cachedTokens: { accessToken: string; refreshToken: string } | null = null;

async function tokens(): Promise<{ accessToken: string; refreshToken: string }> {
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
  const payload = (await res.json()) as {
    data?: { tokens?: { accessToken: string; refreshToken: string } };
  };
  const minted = payload.data?.tokens;
  if (minted === undefined) {
    throw new Error(`[commerce-e2e] could not log the QA user in: ${JSON.stringify(payload)}`);
  }
  cachedTokens = minted;
  return minted;
}

/** An authenticated call to the real API, for the setup a browser cannot perform. */
async function apiCall(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const auth = await tokens();
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${auth.accessToken}`,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * Delivers an inbound WhatsApp message the way Meta does: a POST to the public webhook, signed
 * with the app secret over the exact bytes sent.
 *
 * The signature is computed here rather than bypassed because the gate is the security boundary —
 * a test that skipped it would leave the one middleware standing between the internet and every
 * tenant's inbox completely unexercised.
 */
async function deliverInbound(params: {
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
    const listed = await apiCall(`/orgs/${params.orgId}/conversations?limit=30`);
    const { conversations } = listed.body['data'] as {
      conversations: Array<{ lastMessagePreview: string }>;
    };
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
async function createOrg(page: Page, name: string): Promise<string> {
  await page.getByPlaceholder('New organization name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(`Created ${name}. You are its owner.`)).toBeVisible();
  await expect(
    page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Connected numbers' }) }),
  ).toBeVisible();

  const orgs = await apiCall('/orgs');
  const memberships = (orgs.body['data'] as { memberships: Array<{ org: { id: string; name: string } }> })
    .memberships;
  const created = memberships.find((m) => m.org.name === name);
  if (created === undefined) {
    throw new Error(`[commerce-e2e] created "${name}" in the UI but the API does not list it`);
  }
  return created.org.id;
}

/**
 * Completes a connection through the real API.
 *
 * The browser half — Meta's Embedded Signup dialog — cannot be driven from a test, so the code it
 * would return is handed to the same endpoint the page posts to. Everything downstream of that
 * code is the real thing: the token exchange, `debug_token`, the phone read, the webhook
 * subscription and the vault write all happen against the running backend.
 */
async function connectChannel(orgId: string, code: string, pin?: string): Promise<void> {
  const res = await apiCall(`/orgs/${orgId}/channels/whatsapp`, {
    method: 'POST',
    body: { code, ...(pin === undefined ? {} : { pin }) },
  });
  if (res.status !== 201) {
    throw new Error(`[commerce-e2e] connect failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
}

test.describe('commerce', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    const auth = await tokens();
    context = await browser.newContext({
      storageState: {
        cookies: [],
        origins: [
          { origin: WEB, localStorage: [{ name: 'stewra.tokens', value: JSON.stringify(auth) }] },
        ],
      },
    });
    page = await context.newPage();
  });

  test.afterEach(async () => {
    await context.close();
  });

  test('a new organization starts with no number, and offers to connect one', async () => {
    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    await createOrg(page, `Acme Empty ${Date.now()}`);

    await expect(page.getByText(/No WhatsApp number connected yet/)).toBeVisible();

    // The button exists and is live for an owner — this is what replaced pasting an authorization
    // code by hand.
    const connect = page.getByRole('button', { name: 'Connect WhatsApp Business Account' });
    await expect(connect).toBeEnabled();

    // The Meta app identity is SERVED, not baked into the bundle: the page can only render these
    // because the API told it, which is what lets one build run against different Meta apps.
    await expect(page.getByText(/Meta app \d+ · flow \d+ · Graph v/)).toBeVisible();

    // No PIN is asked for up front. It appears only if the server says the number needs registering.
    await expect(page.getByPlaceholder('Six-digit PIN')).toHaveCount(0);
  });

  test('shows a connected number as active, and disconnects it on request', async () => {
    const wabaId = `waba-lifecycle-${Date.now()}`;
    await setGraphState({ wabaId, phoneStatus: 'CONNECTED' });

    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Lifecycle ${Date.now()}`);
    await connectChannel(orgId, 'e2e-code-lifecycle');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('+1 555 010 0100')).toBeVisible();
    await expect(page.getByText('active', { exact: true })).toBeVisible();

    // A number Meta already reports as CONNECTED must not be re-registered: that call demands a PIN
    // the client may no longer have, which would turn every reconnect into a dead end.
    expect(
      (await graphCalls()).filter((c) => c.pathname.endsWith('/register')),
      'a CONNECTED number must not be sent to /register',
    ).toHaveLength(0);

    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByText(/Channel disconnected/)).toBeVisible();
    await expect(page.getByText(/No WhatsApp number connected yet/)).toBeVisible();
  });

  test('registers a pending number with its PIN, and refuses without one', async () => {
    const wabaId = `waba-pin-${Date.now()}`;
    await setGraphState({ wabaId, phoneStatus: 'PENDING', pin: '654321' });

    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Pin ${Date.now()}`);

    // Without the PIN the server refuses and writes nothing — a client who does not have it to hand
    // loses nothing by trying.
    const refused = await apiCall(`/orgs/${orgId}/channels/whatsapp`, {
      method: 'POST',
      body: { code: 'e2e-code-nopin' },
    });
    expect(refused.status).toBe(400);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/No WhatsApp number connected yet/)).toBeVisible();

    // With it, the number registers and goes active.
    await connectChannel(orgId, 'e2e-code-withpin', '654321');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('active', { exact: true })).toBeVisible();
    expect((await graphCalls()).filter((c) => c.pathname.endsWith('/register')).length).toBeGreaterThan(0);
  });

  test("a customer's message reaches the inbox, and a reply goes back out", async () => {
    const wabaId = `waba-inbox-${Date.now()}`;
    await setGraphState({ wabaId, phoneStatus: 'CONNECTED' });

    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Inbox ${Date.now()}`);
    await connectChannel(orgId, 'e2e-code-inbox');

    const question = `Do you open on Sundays? ${randomUUID().slice(0, 8)}`;
    await deliverInbound({ orgId, wabaId, from: '15551230001', text: question });

    await page.reload({ waitUntil: 'domcontentloaded' });

    // The customer, by name, and their message — routed to THIS org purely by the WABA id in the
    // payload, because Meta delivers every tenant's traffic to the one URL.
    await expect(page.getByText('Dana Customer')).toBeVisible();
    await page.getByText('Dana Customer').click();
    // `.first()`: once the thread is open the text exists twice — the conversation-list preview and
    // the message bubble — and which paints first is a race CI loses. Either one proves the
    // round-trip; strict mode must not fail the test for the message being visible twice.
    await expect(page.getByText(question).first()).toBeVisible();

    // The 24-hour service window is open, so a free-form reply is allowed and the box is offered.
    const reply = page.getByPlaceholder(/Reply/i);
    await expect(reply).toBeVisible();
    const answer = `Yes — 9 to 4. ${randomUUID().slice(0, 8)}`;
    await reply.fill(answer);
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText(answer).first()).toBeVisible();
    // It really left: the backend called Meta's send endpoint over a real socket.
    expect(
      (await graphCalls()).filter((c) => c.pathname.endsWith('/messages')).length,
      'the reply must reach Meta, not just the database',
    ).toBeGreaterThan(0);
  });
});
