import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';

/**
 * WHERE A STORE'S WORD BECOMES AN ENTITLEMENT — the routes and the service between the Play adapter
 * (proved in `commerceGooglePlay.test.ts`) and the `commerce_store_subscriptions` tables.
 *
 * Play is the store driven here, and not for convenience: it is the only one that CAN be driven.
 * Apple's notifications are signed by a certificate chaining to a root this repo pins byte for
 * byte, and Apple's private key is not available to forge a positive case with — so the App Store
 * path is exercised at the adapter seam instead, with a generated authority. Everything above the
 * adapter is one shared service, and it is that service this suite drives end to end.
 *
 * The properties pinned, in the order they would hurt if wrong:
 *
 *  - **A claim is a REFERENCE, never a description.** The request body names a purchase; every
 *    fact written comes back from the store. A body claiming to be active for a purchase Play
 *    reports as expired grants nothing.
 *  - **A purchase belongs to one organization.** The second org to claim it is refused, and the
 *    first keeps it — the direction that matters, because the alternative is a purchase reference
 *    leaking and taking an entitlement with it.
 *  - **Entitlement follows the store's status, not the notification's name.** A verified renewal
 *    that reports `expired` ENDS the plan; a refund revokes it without any lookup at all.
 *  - **A redelivery changes nothing.** Both stores retry, so this is the ordinary case.
 *  - **An unverified POST reaches no database write.** The forged-token case asserts on the rows,
 *    not on the status code.
 */

const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'google-key-1';

const PACKAGE_NAME = 'com.stewra.app';
const PRODUCT_ID = 'com.stewra.standard.monthly';
const OTHER_PRODUCT_ID = 'com.stewra.addon.monthly';
const AUDIENCE = 'https://www.stewra.com/webhooks/stores/google';
const PUSH_SERVICE_ACCOUNT = 'stewra-play-push@stewra.iam.gserviceaccount.com';
/** Unique per run so parallel suites never collide on `commerce_plans.name`. */
const PLAN_NAME = `Store Plan ${randomUUID().slice(0, 8)}`;

function jwks(): { keys: unknown[] } {
  const jwk = google.publicKey.export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] };
}

/** What the scripted Android Publisher returns for the next lookup, and what it was asked. */
let purchase: unknown = null;
let purchaseStatus = 200;
const playCalls: string[] = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const play: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // Drained rather than read: nothing scripts on the request body, but an undrained request never
  // fires 'end' and the whole suite hangs on the first POST.
  req.on('data', () => {});
  req.on('end', () => {
    const path = req.url ?? '/';
    playCalls.push(path);
    if (path === '/jwks') {
      json(res, 200, jwks());
      return;
    }
    if (path === '/token') {
      json(res, 200, { access_token: `ya29.${randomUUID()}`, expires_in: 3599 });
      return;
    }
    if (path.includes('/purchases/subscriptionsv2/tokens/')) {
      json(res, purchaseStatus, purchase ?? { error: { message: 'not found' } });
      return;
    }
    json(res, 404, { error: { message: `unscripted play path: ${path}` } });
  });
});

await new Promise<void>((resolve) => play.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(play.address() as AddressInfo).port}`;

process.env['META_COMMERCE_ENABLED'] = 'true';
process.env['META_COMMERCE_APP_ID'] = '100000000000001';
process.env['META_COMMERCE_APP_SECRET'] = randomBytes(32).toString('hex');
process.env['META_COMMERCE_CONFIG_ID'] = '200000000000002';
process.env['META_COMMERCE_VERIFY_TOKEN'] = `verify-${randomBytes(8).toString('hex')}`;
process.env['META_COMMERCE_GRAPH_BASE_URL'] = 'http://127.0.0.1:9';

process.env['GOOGLE_PLAY_ENABLED'] = 'true';
process.env['GOOGLE_PLAY_PACKAGE_NAME'] = PACKAGE_NAME;
process.env['GOOGLE_PLAY_PRODUCT_ID'] = PRODUCT_ID;
process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL'] = 'stewra-play@stewra.iam.gserviceaccount.com';
process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY'] = serviceAccount.privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;
process.env['GOOGLE_PLAY_PUBSUB_AUDIENCE'] = AUDIENCE;
process.env['GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL'] = PUSH_SERVICE_ACCOUNT;
// PRODUCTION on purpose, as in the adapter suite: a license tester's free purchase must not be
// claimable here, and `sandbox` would make that test pass for the wrong reason.
process.env['GOOGLE_PLAY_ENVIRONMENT'] = 'production';
process.env['GOOGLE_PLAY_API_BASE_URL'] = origin;
process.env['GOOGLE_PLAY_TOKEN_URL'] = `${origin}/token`;
process.env['GOOGLE_PLAY_JWKS_URL'] = `${origin}/jwks`;
process.env['COMMERCE_STORE_PLAN_NAME'] = PLAN_NAME;

const database = (await import('../database/index.js')) as {
  db: typeof dbType;
  closeDb: typeof closeDbType;
};
const { db } = database;
const { config } = await import('../config/unifiedConfig.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const orgRoutes = (await import('../commerce/routes/organizations.js')).default;
const campaignRoutes = (await import('../commerce/routes/campaigns.js')).default;
const storeWebhookRoutes = (await import('../commerce/routes/storeWebhook.js')).default;
const { organizationRepository } = await import(
  '../commerce/repositories/organizationRepository.js'
);
const { planRepository } = await import('../commerce/repositories/planRepository.js');

const app = express();
// Raw-body webhook BEFORE express.json, mirroring app.ts.
app.use('/webhooks/stores', storeWebhookRoutes);
app.use(express.json());
app.use('/orgs', orgRoutes);
app.use('/orgs/:orgId', campaignRoutes);
app.use(errorHandler);

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdOrgs: string[] = [];
const createdUsers: string[] = [];
let planId = '';

function bearer(userId: string): string {
  return `Bearer ${jwt.sign({ sub: userId, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
}

async function createUser(): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({
      email: `stores-${randomUUID()}@stewra.invalid`,
      display_name: 'Stores Tester',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

async function tenant(): Promise<{ orgId: string; userId: string; auth: string }> {
  const userId = await createUser();
  const { org } = await organizationRepository.create({
    name: 'Stores Test Org',
    slug: `stores-${randomUUID().slice(0, 12)}`,
    createdBy: userId,
  });
  createdOrgs.push(org.id);
  return { orgId: org.id, userId, auth: bearer(userId) };
}

// ── The wire shapes ──────────────────────────────────────────────────────────────────────────────

interface TokenOverrides {
  aud?: string;
  email?: string;
  expiresIn?: number;
}

function oidcToken(overrides: TokenOverrides = {}, key = google.privateKey): string {
  return jwt.sign(
    {
      iss: 'https://accounts.google.com',
      aud: overrides.aud ?? AUDIENCE,
      email: overrides.email ?? PUSH_SERVICE_ACCOUNT,
      email_verified: true,
    },
    key,
    { algorithm: 'RS256', keyid: KID, expiresIn: overrides.expiresIn ?? 600 },
  );
}

function push(notification: unknown, messageId = randomUUID()): string {
  return JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify(notification)).toString('base64'),
      messageId,
    },
    subscription: 'projects/stewra/subscriptions/play-rtdn',
  });
}

/** A subscription RTDN. `notificationType` is deliberately arbitrary — Play's word is the lookup. */
function subscriptionPush(
  purchaseToken: string,
  notificationType = 2,
  messageId = randomUUID(),
): string {
  return push(
    {
      packageName: PACKAGE_NAME,
      subscriptionNotification: { notificationType, purchaseToken, subscriptionId: PRODUCT_ID },
    },
    messageId,
  );
}

const IN_20_DAYS = (): string => new Date(Date.now() + 20 * 86_400_000).toISOString();
const DAYS_AGO = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

function activePurchase(overrides: Record<string, unknown> = {}): unknown {
  return {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    latestOrderId: `GPA.${randomUUID().slice(0, 12)}`,
    lineItems: [
      {
        productId: PRODUCT_ID,
        expiryTime: IN_20_DAYS(),
        autoRenewingPlan: { autoRenewEnabled: true },
      },
    ],
    ...overrides,
  };
}

async function claim(
  t: { orgId: string; auth: string },
  storeSubscriptionRef: string,
): Promise<request.Response> {
  return request(app)
    .post(`/orgs/${t.orgId}/billing/store-purchase`)
    .set('authorization', t.auth)
    .send({ store: 'google', storeSubscriptionRef });
}

async function deliver(body: string, token = `Bearer ${oidcToken()}`): Promise<request.Response> {
  return request(app)
    .post('/webhooks/stores/google')
    .set('authorization', token)
    .set('content-type', 'application/json')
    .send(body);
}

async function storeRow(ref: string): Promise<
  | {
      org_id: string;
      status: string;
      auto_renewing: boolean;
      subscription_id: string | null;
      environment: string;
    }
  | undefined
> {
  return db
    .selectFrom('commerce_store_subscriptions')
    .select(['org_id', 'status', 'auto_renewing', 'subscription_id', 'environment'])
    .where('store', '=', 'google')
    .where('store_subscription_ref', '=', ref)
    .executeTakeFirst();
}

async function notifications(): Promise<
  Array<{ notification_ref: string; applied: boolean; store_subscription_ref: string | null }>
> {
  return db
    .selectFrom('commerce_store_notifications')
    .select(['notification_ref', 'applied', 'store_subscription_ref'])
    .where('store', '=', 'google')
    .orderBy('received_at')
    .execute();
}

beforeAll(async () => {
  const { plan } = await planRepository.upsertPlanVersion({
    name: PLAN_NAME,
    // $213/mo, in micros: what the store lists so that $149 net survives a 30% commission.
    platformFeeMicros: 213_000_000n,
    currency: 'USD',
    note: 'store-sold plan for the store subscription suite',
    createdByUserId: null,
  });
  planId = plan.id;
});

beforeEach(() => {
  playCalls.length = 0;
  purchaseStatus = 200;
  purchase = activePurchase();
});

afterAll(async () => {
  await new Promise<void>((resolve) => play.close(() => resolve()));
  if (createdOrgs.length > 0) {
    // The notifications table is append-only by trigger, and its rows carry no org — they are keyed
    // on the store's own reference, which is what this suite generates fresh per test. Dropping the
    // trigger to tidy them would be dismantling the property the migration exists to hold, so they
    // are left; every ref here is a uuid and cannot collide with another run.
    await db
      .deleteFrom('commerce_store_subscriptions')
      .where('org_id', 'in', createdOrgs)
      .execute();
    await db.deleteFrom('commerce_subscriptions').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (planId !== '') {
    // Plan versions are append-only by trigger — a subscriber's price cannot change because
    // somebody edited a catalog row. Same dance as `commerceBilling.test.ts`: drop it for the
    // teardown only, and put it back inside the same transaction.
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_plan_versions DISABLE TRIGGER trg_commerce_plan_versions_append_only`.execute(trx);
      await trx.deleteFrom('commerce_plan_versions').where('plan_id', '=', planId).execute();
      await sql`ALTER TABLE commerce_plan_versions ENABLE TRIGGER trg_commerce_plan_versions_append_only`.execute(trx);
      await trx.deleteFrom('commerce_plans').where('id', '=', planId).execute();
    });
  }
  if (createdUsers.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  await database.closeDb();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('claiming a purchase', () => {
  it('writes what Play says and puts the organization on the plan', async () => {
    const t = await tenant();
    const ref = `token-${randomUUID()}`;
    const res = await claim(t, ref);

    expect(res.status).toBe(200);
    expect(res.body.data.storeSubscription.status).toBe('active');
    expect(res.body.data.storeSubscription.productId).toBe(PRODUCT_ID);
    // The collector is the whole point: an org billed by Play must never also be invoiced here.
    expect(res.body.data.subscription.collector).toBe('google');
    expect(res.body.data.subscription.planId).toBe(planId);

    const row = await storeRow(ref);
    expect(row?.org_id).toBe(t.orgId);
    expect(row?.subscription_id).toBe(res.body.data.subscription.id);
    // The claim carried nothing but a reference; the lookup is what produced every fact above.
    expect(playCalls.some((p) => p.includes('/purchases/subscriptionsv2/tokens/'))).toBe(true);
  });

  it('believes the store and not the claimant when the two disagree', async () => {
    // Play says this purchase ran out a week ago. The app is claiming it anyway — which is exactly
    // what a replayed or edited body looks like, and there is no field in the request that could
    // argue otherwise, because the request has no such field.
    const t = await tenant();
    purchase = {
      subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
      lineItems: [{ productId: PRODUCT_ID, expiryTime: DAYS_AGO(7) }],
    };
    const res = await claim(t, `token-${randomUUID()}`);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toMatch(/expired/);
    const active = await planRepository.activeSubscription(t.orgId);
    expect(active).toBeNull();
  });

  it('refuses a product this install does not sell', async () => {
    // Ship a cheaper tier one day and this is the difference between selling it and giving away
    // the full plan to anyone who buys it.
    const t = await tenant();
    purchase = activePurchase({
      lineItems: [
        { productId: OTHER_PRODUCT_ID, expiryTime: IN_20_DAYS(), autoRenewingPlan: {} },
      ],
    });
    const res = await claim(t, `token-${randomUUID()}`);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toMatch(new RegExp(OTHER_PRODUCT_ID));
    expect(await planRepository.activeSubscription(t.orgId)).toBeNull();
  });

  it("refuses a license tester's free purchase on a production install", async () => {
    const t = await tenant();
    purchase = activePurchase({ testPurchase: {} });
    const res = await claim(t, `token-${randomUUID()}`);

    expect(res.status).toBe(401);
    expect(await planRepository.activeSubscription(t.orgId)).toBeNull();
  });

  it('refuses a purchase Play does not know', async () => {
    const t = await tenant();
    purchaseStatus = 404;
    purchase = { error: { message: 'not found' } };
    const res = await claim(t, `token-${randomUUID()}`);

    expect(res.status).toBe(400);
    expect(await planRepository.activeSubscription(t.orgId)).toBeNull();
  });

  it('gives one purchase to one organization, and the first claimant keeps it', async () => {
    const first = await tenant();
    const second = await tenant();
    const ref = `token-${randomUUID()}`;

    expect((await claim(first, ref)).status).toBe(200);
    const res = await claim(second, ref);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toMatch(/already claimed by another organization/);
    expect((await storeRow(ref))?.org_id).toBe(first.orgId);
    expect(await planRepository.activeSubscription(second.orgId)).toBeNull();
  });

  it('is idempotent for the organization that already owns it', async () => {
    const t = await tenant();
    const ref = `token-${randomUUID()}`;
    const first = await claim(t, ref);
    const second = await claim(t, ref);

    expect(second.status).toBe(200);
    // Re-claiming refreshes state; it does not start a second plan tenure.
    expect(second.body.data.subscription.id).toBe(first.body.data.subscription.id);
    const tenures = await db
      .selectFrom('commerce_subscriptions')
      .select('id')
      .where('org_id', '=', t.orgId)
      .execute();
    expect(tenures).toHaveLength(1);
  });

  it('refuses a claim from someone who is not an admin of that organization', async () => {
    const owner = await tenant();
    const outsider = await tenant();
    const res = await request(app)
      .post(`/orgs/${owner.orgId}/billing/store-purchase`)
      .set('authorization', outsider.auth)
      .send({ store: 'google', storeSubscriptionRef: `token-${randomUUID()}` });

    // 404, not 403 — the tenancy choke point never confirms an org id exists to a non-member.
    expect(res.status).toBe(404);
    expect(playCalls.some((p) => p.includes('/purchases/'))).toBe(false);
  });
});

describe('a notification, through the route', () => {
  it('updates a claimed subscription from what Play says now', async () => {
    const t = await tenant();
    const ref = `token-${randomUUID()}`;
    await claim(t, ref);

    purchase = activePurchase({
      subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
      lineItems: [{ productId: PRODUCT_ID, expiryTime: DAYS_AGO(1), autoRenewingPlan: {} }],
    });
    const res = await deliver(subscriptionPush(ref));

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('applied');
    const row = await storeRow(ref);
    expect(row?.status).toBe('grace_period');
    // Grace is still entitled: the plan must survive a failed card while Play retries it.
    expect(row?.subscription_id).not.toBeNull();
  });

  it('ends the plan when the store says the subscription has lapsed', async () => {
    const t = await tenant();
    const ref = `token-${randomUUID()}`;
    await claim(t, ref);
    expect(await planRepository.activeSubscription(t.orgId)).not.toBeNull();

    purchase = {
      subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
      lineItems: [{ productId: PRODUCT_ID, expiryTime: DAYS_AGO(1) }],
    };
    // notificationType 4 is SUBSCRIPTION_PURCHASED — the name says the opposite of what happened,
    // and it is ignored on purpose. Entitlement follows the state Play reports, never the label.
    await deliver(subscriptionPush(ref, 4));

    expect((await storeRow(ref))?.status).toBe('expired');
    expect((await storeRow(ref))?.subscription_id).toBeNull();
    expect(await planRepository.activeSubscription(t.orgId)).toBeNull();
  });

  it('re-grants the plan when a lapsed subscription is paid again', async () => {
    const t = await tenant();
    const ref = `token-${randomUUID()}`;
    await claim(t, ref);

    purchase = {
      subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD',
      lineItems: [{ productId: PRODUCT_ID, expiryTime: DAYS_AGO(1) }],
    };
    await deliver(subscriptionPush(ref));
    expect(await planRepository.activeSubscription(t.orgId)).toBeNull();

    purchase = activePurchase();
    await deliver(subscriptionPush(ref));

    // The whole reason `subscription_id` is cleared on lapse: a stale pointer here would look
    // already-granted and this org would never get its plan back after a recovered payment.
    const active = await planRepository.activeSubscription(t.orgId);
    expect(active?.collector).toBe('google');
    expect((await storeRow(ref))?.subscription_id).toBe(active?.id);
  });

  it('revokes a refunded purchase without asking Play about it', async () => {
    const t = await tenant();
    const ref = `token-${randomUUID()}`;
    await claim(t, ref);
    playCalls.length = 0;

    // A voided purchase reads back as merely expired, and often 404s outright — so the refund
    // notification is the only thing that will ever say the money went back, and it must be acted
    // on with no lookup at all. `purchaseStatus` is set to prove the point: if anything did look,
    // it would fail rather than quietly succeed.
    purchaseStatus = 410;
    purchase = { error: { message: 'gone' } };
    const res = await deliver(
      push({
        packageName: PACKAGE_NAME,
        voidedPurchaseNotification: { purchaseToken: ref, orderId: 'GPA.void', productType: 1 },
      }),
    );

    expect(res.status).toBe(200);
    expect(playCalls.some((p) => p.includes('/purchases/'))).toBe(false);
    const row = await storeRow(ref);
    expect(row?.status).toBe('revoked');
    expect(row?.auto_renewing).toBe(false);
    expect(row?.subscription_id).toBeNull();
    expect(await planRepository.activeSubscription(t.orgId)).toBeNull();
  });

  it('follows a re-issued purchase token forward instead of leaving two rows', async () => {
    const t = await tenant();
    const oldRef = `token-${randomUUID()}`;
    const newRef = `token-${randomUUID()}`;
    await claim(t, oldRef);
    const granted = await planRepository.activeSubscription(t.orgId);

    // An upgrade: Play mints a new token and names the one it replaces. Writing a second row would
    // leave the old token still reading entitled and the new one owned by nobody.
    purchase = activePurchase({ linkedPurchaseToken: oldRef });
    const res = await deliver(subscriptionPush(newRef));

    expect(res.body.outcome).toBe('applied');
    expect(await storeRow(oldRef)).toBeUndefined();
    const moved = await storeRow(newRef);
    expect(moved?.org_id).toBe(t.orgId);
    expect(moved?.subscription_id).toBe(granted?.id);
  });

  it('records a notification for a purchase nobody has claimed, and applies nothing', async () => {
    const ref = `token-${randomUUID()}`;
    const res = await deliver(subscriptionPush(ref));

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('unclaimed');
    expect(await storeRow(ref)).toBeUndefined();
    // "We were told and did nothing" is the fact worth having when somebody asks why an
    // entitlement never appeared — so it is recorded, not dropped.
    const recorded = (await notifications()).find((n) => n.store_subscription_ref === ref);
    expect(recorded?.applied).toBe(false);
  });

  it('does not apply a notification twice', async () => {
    const t = await tenant();
    const ref = `token-${randomUUID()}`;
    await claim(t, ref);

    const messageId = randomUUID();
    purchase = {
      subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
      lineItems: [{ productId: PRODUCT_ID, expiryTime: DAYS_AGO(1) }],
    };
    expect((await deliver(subscriptionPush(ref, 2, messageId))).body.outcome).toBe('applied');
    expect((await storeRow(ref))?.status).toBe('expired');

    // Pub/Sub redelivers at least once by design; Apple retries for hours. The same message id
    // arrives again — and this time Play would answer ACTIVE, which is what makes the assertion
    // mean something: a second apply would visibly resurrect the subscription. The dedupe is at
    // the service rather than in front of the port, so the redelivery is still authenticated and
    // still costs a lookup; what it does not cost is a write.
    purchase = activePurchase();
    const replay = await deliver(subscriptionPush(ref, 2, messageId));
    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toBe('replay');
    expect((await storeRow(ref))?.status).toBe('expired');
    expect(await planRepository.activeSubscription(t.orgId)).toBeNull();
  });

  it('acknowledges a test ping without touching anything', async () => {
    const res = await deliver(push({ packageName: PACKAGE_NAME, testNotification: { version: '1.0' } }));

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('ignored');
  });

  it('records but does not apply a notification for another product', async () => {
    const t = await tenant();
    const ref = `token-${randomUUID()}`;
    await claim(t, ref);

    purchase = activePurchase({
      subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
      lineItems: [{ productId: OTHER_PRODUCT_ID, expiryTime: DAYS_AGO(1) }],
    });
    const res = await deliver(subscriptionPush(ref));

    // ACKed, because the store is not wrong to have sent it and a 500 would have it retried for
    // hours — but the row for the product we DO sell is untouched.
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('foreign_product');
    expect((await storeRow(ref))?.status).toBe('active');
    expect(await planRepository.activeSubscription(t.orgId)).not.toBeNull();
  });
});

describe('an unverified delivery', () => {
  it("writes nothing when the token is signed by a key Google never published", async () => {
    const t = await tenant();
    const ref = `token-${randomUUID()}`;
    await claim(t, ref);

    purchase = {
      subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
      lineItems: [{ productId: PRODUCT_ID, expiryTime: DAYS_AGO(1) }],
    };
    const before = (await notifications()).length;
    const res = await deliver(subscriptionPush(ref), `Bearer ${oidcToken({}, forger.privateKey)}`);

    expect(res.status).toBe(401);
    // The assertion that matters is on the rows, not the status: a 401 that had already expired
    // somebody's subscription would still be a 401.
    expect((await storeRow(ref))?.status).toBe('active');
    expect(await planRepository.activeSubscription(t.orgId)).not.toBeNull();
    expect((await notifications()).length).toBe(before);
  });

  it("writes nothing when the token is Google's but belongs to somebody else's push", async () => {
    const t = await tenant();
    const ref = `token-${randomUUID()}`;
    await claim(t, ref);

    // Genuinely Google-signed, genuinely valid, and not ours. Without the email check this is a
    // write anyone with a Google Cloud project can make.
    const res = await deliver(
      subscriptionPush(ref),
      `Bearer ${oidcToken({ email: 'someone-else@their-project.iam.gserviceaccount.com' })}`,
    );

    expect(res.status).toBe(401);
    expect((await storeRow(ref))?.status).toBe('active');
  });

  it('refuses a delivery with no bearer token at all', async () => {
    const res = await request(app)
      .post('/webhooks/stores/google')
      .set('content-type', 'application/json')
      .send(subscriptionPush(`token-${randomUUID()}`));

    expect(res.status).toBe(401);
  });
});
