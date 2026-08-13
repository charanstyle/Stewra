import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';
import type { CommerceJob } from '@stewra/shared-types';

/**
 * BILLING (migrations 053/054) — plans whose fee is frozen per version, subscriptions, and the
 * period close that turns an ended month into invoices, or honestly refuses to.
 *
 * The properties pinned here are the ones a shortcut would fake: an issued invoice never changes;
 * a period with unpriced or unrated messages produces only drafts, and heals through the backfill
 * rather than through anyone editing a document; money that arrives late bills into the OPEN
 * period, never into a closed one; and the platform surface is invisible to org users.
 */

const APP_ID = '100000000000001';
const APP_HMAC = randomBytes(32).toString('hex');

process.env['META_COMMERCE_ENABLED'] = 'true';
process.env['META_COMMERCE_APP_ID'] = APP_ID;
process.env['META_COMMERCE_APP_SECRET'] = APP_HMAC;
process.env['META_COMMERCE_CONFIG_ID'] = '200000000000002';
process.env['META_COMMERCE_VERIFY_TOKEN'] = `verify-${randomBytes(8).toString('hex')}`;
// Nothing in this suite reaches Meta; a dead port keeps any accidental call an error, not a wait.
process.env['META_COMMERCE_GRAPH_BASE_URL'] = 'http://127.0.0.1:9';

const database = (await import('../database/index.js')) as {
  db: typeof dbType;
  closeDb: typeof closeDbType;
};
const { db } = database;
const { config } = await import('../config/unifiedConfig.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const orgRoutes = (await import('../commerce/routes/organizations.js')).default;
const billingRoutes = (await import('../commerce/routes/billing.js')).default;
const { organizationRepository } = await import(
  '../commerce/repositories/organizationRepository.js'
);
const { channelAccountRepository } = await import(
  '../commerce/repositories/channelAccountRepository.js'
);
const { commerceInboxRepository } = await import(
  '../commerce/repositories/commerceInboxRepository.js'
);
const { rateCardRepository } = await import('../commerce/repositories/rateCardRepository.js');
const { spendCapRepository } = await import('../commerce/repositories/spendCapRepository.js');
const { jobRepository } = await import('../commerce/repositories/jobRepository.js');
const { billingService } = await import('../commerce/services/billingService.js');
const { costRatingService } = await import('../commerce/services/costRatingService.js');
const { messageCostBackfillHandler } = await import(
  '../commerce/jobs/messageCostBackfillHandler.js'
);
const { commerceWorker } = await import('../commerce/jobs/worker.js');
const { vault } = await import('../control-plane/vault/vault.js');

const app = express();
app.use(express.json());
app.use('/orgs', orgRoutes);
app.use('/platform/billing', billingRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdOrgs: string[] = [];
const createdUsers: string[] = [];
const createdSecrets: string[] = [];
const createdCards: string[] = [];
const createdPlans: string[] = [];

// One live card per currency install-wide; a never-real currency keeps this suite out of every
// other suite's way, and out of its own past runs' way.
const CUR = `Z${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}`;
/** Micros one marketing message to country 1 costs on this suite's card. */
const RATE = 10_000n;
/** Micros one marketing message to country 44 costs, once the SECOND card teaches that price. */
const RATE_44 = 60_000n;
/** The flat monthly platform fee this suite's plans charge. */
const FEE = 5_000_000n;

// The third address in the test INSTALL_ADMIN_EMAILS list — the first two belong to the rates and
// spend-cap suites, and suites racing to create the same unique email would fail each other.
const OPERATOR_EMAIL = 'billing-admin@stewra.test';

const now = new Date();
/** First of last month / this month, UTC — the period this suite closes and the one it must not. */
const LAST_MONTH = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  .toISOString()
  .slice(0, 10);
const THIS_MONTH = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  .toISOString()
  .slice(0, 10);
/** A timestamp safely inside last month. */
const MID_LAST_MONTH = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12));

function bearer(userId: string): string {
  return `Bearer ${jwt.sign({ sub: userId, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
}

async function createUser(email: string): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({
      email,
      display_name: 'Billing Tester',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

interface Tenant {
  readonly orgId: string;
  readonly userId: string;
  readonly auth: string;
  readonly accountId: string;
}

async function tenant(): Promise<Tenant> {
  const userId = await createUser(`billing-${randomUUID()}@stewra.invalid`);
  const { org } = await organizationRepository.create({
    name: 'Billing Test Org',
    slug: `billing-${randomUUID().slice(0, 12)}`,
    createdBy: userId,
  });
  createdOrgs.push(org.id);

  const credentialRef = await vault.put(`test-token-${randomUUID()}`);
  createdSecrets.push(credentialRef);
  const { account } = await channelAccountRepository.upsert({
    orgId: org.id,
    platform: 'whatsapp_cloud',
    externalAccountId: `waba-${randomUUID().slice(0, 12)}`,
    phoneNumberId: `pn-${randomUUID().slice(0, 12)}`,
    displayName: 'Billing Test Number',
    displayPhoneNumber: null,
    credentialRef,
    credentialExpiresAt: null,
    billingCurrency: CUR,
    meta: {},
  });

  return { orgId: org.id, userId, auth: bearer(userId), accountId: account.id };
}

let contactSerial = 0;
/**
 * One outbound message that went out, with its own contact and conversation. `callingCode` picks
 * the recipient country — '1' is priced on the first card, '44' only on the second.
 */
async function sentMessage(
  t: Tenant,
  callingCode: '1' | '44' = '1',
): Promise<{ messageId: string; conversationId: string }> {
  contactSerial += 1;
  const phone = `${callingCode}555${String(3_000_000 + contactSerial * 17 + Math.floor(Math.random() * 12))}`;
  const contactId = await commerceInboxRepository.upsertContact({
    orgId: t.orgId,
    platform: 'whatsapp_cloud',
    externalId: phone,
    displayName: 'Billed Customer',
    phoneE164: `+${phone}`,
  });
  const conversationId = await commerceInboxRepository.upsertConversation({
    orgId: t.orgId,
    channelAccountId: t.accountId,
    contactId,
    platform: 'whatsapp_cloud',
  });
  const message = await commerceInboxRepository.recordOutbound({
    orgId: t.orgId,
    conversationId,
    platform: 'whatsapp_cloud',
    body: 'billed line',
    sentByUserId: t.userId,
  });
  await db
    .updateTable('commerce_messages')
    .set({ status: 'sent', provider_message_id: `wamid.${randomUUID()}` })
    .where('id', '=', message.id)
    .execute();
  return { messageId: message.id, conversationId };
}

/** Stamp the receipt facts on the row (what applyDeliveryStatus captures) and rate it. */
async function rateAsMarketing(t: Tenant, m: { messageId: string; conversationId: string }): Promise<void> {
  await db
    .updateTable('commerce_messages')
    .set({ billable: true, pricing_category: 'marketing', status: 'delivered' })
    .where('id', '=', m.messageId)
    .execute();
  await costRatingService.rateMessage({
    orgId: t.orgId,
    messageId: m.messageId,
    conversationId: m.conversationId,
    billable: true,
    pricingCategory: 'marketing',
    providerConversationId: null,
    billingCurrency: CUR,
  });
}

/**
 * Move a message (and its cost row, if any) into last month, where the close will find it. Raw SQL
 * because these timestamps are write-once in the schema types — the harness backdates fixtures the
 * way real time would have laid them down.
 */
async function ageIntoLastMonth(messageId: string): Promise<void> {
  await sql`UPDATE commerce_messages SET created_at = ${MID_LAST_MONTH} WHERE id = ${messageId}`.execute(db);
  await sql`UPDATE commerce_message_costs SET priced_at = ${MID_LAST_MONTH} WHERE message_id = ${messageId}`.execute(db);
}

/** Fee accrues for the month a subscription overlaps — backdate the start so last month counts. */
async function backdateSubscription(orgId: string): Promise<void> {
  await sql`UPDATE commerce_subscriptions SET started_at = ${MID_LAST_MONTH} WHERE org_id = ${orgId}`.execute(db);
}

/** A claimed-job literal for driving a handler directly, without the queue in between. */
function jobFor(orgId: string, kind: CommerceJob['kind'], payload: CommerceJob['payload']): CommerceJob {
  const nowIso = new Date().toISOString();
  return {
    id: randomUUID(),
    orgId,
    kind,
    payload,
    status: 'running',
    runAfter: nowIso,
    attempts: 1,
    maxAttempts: 5,
    lastError: null,
    lockedBy: 'test',
    lockedUntil: nowIso,
    dedupeKey: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    finishedAt: null,
  };
}

/** Run the queue until this org has nothing left queued or running. */
async function drainJobs(orgId: string, maxPasses = 25): Promise<void> {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const open = await db
      .selectFrom('commerce_jobs')
      .select('id')
      .where('org_id', '=', orgId)
      .where('status', 'in', ['queued', 'running'])
      .execute();
    if (open.length === 0) return;
    await db
      .updateTable('commerce_jobs')
      .set({ run_after: new Date(Date.now() - 1000) })
      .where('id', 'in', open.map((row) => row.id))
      .execute();
    await commerceWorker.runOnce();
  }
  throw new Error(`org ${orgId} still has open jobs after ${maxPasses} passes`);
}

async function invoicesOf(orgId: string): Promise<
  Array<{ id: string; currency: string; status: string; total_micros: string; period_start: Date }>
> {
  return db
    .selectFrom('commerce_invoices')
    .select(['id', 'currency', 'status', 'total_micros', 'period_start'])
    .where('org_id', '=', orgId)
    .orderBy('period_start')
    .execute();
}

let operatorId = '';

beforeAll(async () => {
  // Other suites leave their own jobs behind, and the worker's claim is global by design.
  await db.deleteFrom('commerce_jobs').execute();

  operatorId = await createUser(OPERATOR_EMAIL);

  const loaderId = await createUser(`billing-loader-${randomUUID()}@stewra.invalid`);
  const card = await rateCardRepository.loadCard({
    currency: CUR,
    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    sourceNote: 'billing suite sheet — country 1 only; 44 arrives with the second card',
    loadedByUserId: loaderId,
    rates: [
      { countryCallingCode: '1', pricingCategory: 'marketing', amountMicros: RATE, unit: 'per_message' },
    ],
  });
  createdCards.push(card.id);

  if (!config.installAdmins.includes(OPERATOR_EMAIL)) {
    throw new Error(
      `INSTALL_ADMIN_EMAILS must include ${OPERATOR_EMAIL} for this suite (fix backend/.env.test and ci.yml)`,
    );
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const ref of createdSecrets) {
    await vault.delete(ref);
  }
  if (createdOrgs.length > 0) {
    await db.deleteFrom('commerce_jobs').where('org_id', 'in', createdOrgs).execute();
    // Issued invoices are delete-protected by trigger; lifted only here in the harness.
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_invoice_lines DISABLE TRIGGER trg_commerce_invoice_lines_draft_only`.execute(trx);
      await sql`ALTER TABLE commerce_invoices DISABLE TRIGGER trg_commerce_invoices_issued_immutable`.execute(trx);
      await trx
        .deleteFrom('commerce_invoice_lines')
        .where(
          'invoice_id',
          'in',
          trx.selectFrom('commerce_invoices').select('id').where('org_id', 'in', createdOrgs),
        )
        .execute();
      await trx.deleteFrom('commerce_invoices').where('org_id', 'in', createdOrgs).execute();
      await sql`ALTER TABLE commerce_invoices ENABLE TRIGGER trg_commerce_invoices_issued_immutable`.execute(trx);
      await sql`ALTER TABLE commerce_invoice_lines ENABLE TRIGGER trg_commerce_invoice_lines_draft_only`.execute(trx);
    });
    await db.deleteFrom('commerce_billing_periods').where('org_id', 'in', createdOrgs).execute();
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_spend_ledger DISABLE TRIGGER stewra_commerce_spend_ledger_append_only`.execute(trx);
      await trx.deleteFrom('commerce_spend_ledger').where('org_id', 'in', createdOrgs).execute();
      await sql`ALTER TABLE commerce_spend_ledger ENABLE TRIGGER stewra_commerce_spend_ledger_append_only`.execute(trx);
    });
    await db.deleteFrom('commerce_spend_periods').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_spend_caps').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_message_costs').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_messages').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_conversations').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_contacts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_subscriptions').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('channel_accounts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdPlans.length > 0) {
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_plan_versions DISABLE TRIGGER trg_commerce_plan_versions_append_only`.execute(trx);
      await trx.deleteFrom('commerce_plan_versions').where('plan_id', 'in', createdPlans).execute();
      await sql`ALTER TABLE commerce_plan_versions ENABLE TRIGGER trg_commerce_plan_versions_append_only`.execute(trx);
      await trx.deleteFrom('commerce_plans').where('id', 'in', createdPlans).execute();
    });
  }
  if (createdCards.length > 0) {
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_message_rates DISABLE TRIGGER trg_commerce_message_rates_append_only`.execute(trx);
      await sql`ALTER TABLE commerce_rate_cards DISABLE TRIGGER trg_commerce_rate_cards_close_only`.execute(trx);
      await trx.deleteFrom('commerce_message_rates').where('rate_card_id', 'in', createdCards).execute();
      await trx.deleteFrom('commerce_rate_cards').where('id', 'in', createdCards).execute();
      await sql`ALTER TABLE commerce_rate_cards ENABLE TRIGGER trg_commerce_rate_cards_close_only`.execute(trx);
      await sql`ALTER TABLE commerce_message_rates ENABLE TRIGGER trg_commerce_message_rates_append_only`.execute(trx);
    });
  }
  if (createdUsers.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  await database.closeDb();
});

// ---------------------------------------------------------------------------------------------

describe('the catalog', () => {
  it('an operator versions a plan; the platform surface does not exist for org users', async () => {
    const name = `Pilot ${randomUUID().slice(0, 8)}`;
    const v1 = await request(app)
      .put('/platform/billing/plans')
      .set('Authorization', bearer(operatorId))
      .send({ name, platformFeeMicros: FEE.toString(), currency: CUR, note: 'launch pricing' });
    expect(v1.status).toBe(200);
    expect(v1.body.data.version).toMatchObject({ version: 1, platformFeeMicros: FEE.toString() });
    createdPlans.push(v1.body.data.plan.id as string);

    // Same name again: version 2 appended, version 1 untouched — nobody's frozen price moved.
    const v2 = await request(app)
      .put('/platform/billing/plans')
      .set('Authorization', bearer(operatorId))
      .send({ name, platformFeeMicros: (FEE * 2n).toString(), currency: CUR, note: 'price rise' });
    expect(v2.status).toBe(200);
    expect(v2.body.data.version).toMatchObject({ version: 2 });

    const list = await request(app)
      .get('/platform/billing/plans')
      .set('Authorization', bearer(operatorId));
    expect(list.status).toBe(200);
    const entry = (
      list.body.data.plans as Array<{ plan: { name: string }; versions: Array<{ version: number }> }>
    ).find((p) => p.plan.name === name);
    expect(entry?.versions.map((v) => v.version)).toEqual([2, 1]);

    // To an org user — owner included — the surface is a 404, not a 403: it does not exist.
    const t = await tenant();
    const write = await request(app)
      .put('/platform/billing/plans')
      .set('Authorization', t.auth)
      .send({ name: 'Self Serve', platformFeeMicros: '0', currency: CUR, note: 'free for me' });
    expect(write.status).toBe(404);
    const read = await request(app).get('/platform/billing/plans').set('Authorization', t.auth);
    expect(read.status).toBe(404);
  });

  it('subscribing freezes the latest version; org reads its own plan and nobody else’s', async () => {
    const name = `Standard ${randomUUID().slice(0, 8)}`;
    const created = await billingService.upsertPlan({
      name,
      platformFeeMicros: FEE.toString(),
      currency: CUR,
      note: 'v1',
      createdByUserId: operatorId,
    });
    createdPlans.push(created.plan.id);

    const t = await tenant();
    const set = await request(app)
      .put('/platform/billing/subscriptions')
      .set('Authorization', bearer(operatorId))
      .send({ orgId: t.orgId, planId: created.plan.id, note: 'signed order form' });
    expect(set.status).toBe(200);
    expect(set.body.data.subscription).toMatchObject({
      planName: name,
      planVersion: 1,
      platformFeeMicros: FEE.toString(),
      currency: CUR,
    });

    // A new version after subscribing changes nothing for this org until an operator moves them.
    await billingService.upsertPlan({
      name,
      platformFeeMicros: (FEE * 3n).toString(),
      currency: CUR,
      note: 'v2',
      createdByUserId: operatorId,
    });
    const own = await request(app).get(`/orgs/${t.orgId}/billing`).set('Authorization', t.auth);
    expect(own.status).toBe(200);
    expect(own.body.data.subscription).toMatchObject({
      planVersion: 1,
      platformFeeMicros: FEE.toString(),
    });

    // Another org's admin sees a tenancy refusal, not a neighbor's plan.
    const outsider = await tenant();
    const cross = await request(app)
      .get(`/orgs/${t.orgId}/billing`)
      .set('Authorization', outsider.auth);
    expect([403, 404]).toContain(cross.status);

    // Off the plan: the subscription row is ended, never erased.
    const cleared = await request(app)
      .put('/platform/billing/subscriptions')
      .set('Authorization', bearer(operatorId))
      .send({ orgId: t.orgId, planId: null, note: 'churned' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.subscription).toBeNull();
    const history = await db
      .selectFrom('commerce_subscriptions')
      .select(['ended_at'])
      .where('org_id', '=', t.orgId)
      .execute();
    expect(history).toHaveLength(1);
    expect(history[0]?.ended_at).not.toBeNull();
  });
});

describe('the close', () => {
  it('closes a complete month into an issued, immutable invoice: pass-through plus the flat fee', async () => {
    const t = await tenant();
    const created = await billingService.upsertPlan({
      name: `Issued ${randomUUID().slice(0, 8)}`,
      platformFeeMicros: FEE.toString(),
      currency: CUR,
      note: 'flat',
      createdByUserId: operatorId,
    });
    createdPlans.push(created.plan.id);
    await billingService.setSubscription({
      orgId: t.orgId,
      planId: created.plan.id,
      note: 'signed',
      createdByUserId: operatorId,
    });
    await backdateSubscription(t.orgId);

    const m1 = await sentMessage(t);
    const m2 = await sentMessage(t);
    await rateAsMarketing(t, m1);
    await rateAsMarketing(t, m2);
    await ageIntoLastMonth(m1.messageId);
    await ageIntoLastMonth(m2.messageId);

    // Through the REAL queue: the registry knows the kind, the worker runs it.
    const job = await jobRepository.enqueue({
      orgId: t.orgId,
      kind: 'billing_period_close',
      payload: { periodStart: LAST_MONTH },
    });
    expect(job).not.toBeNull();
    await drainJobs(t.orgId);

    const rows = await invoicesOf(t.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      currency: CUR,
      status: 'issued',
      total_micros: (2n * RATE + FEE).toString(),
    });

    // The org reads its bill over HTTP: both lines, each explaining itself.
    const list = await request(app).get(`/orgs/${t.orgId}/invoices`).set('Authorization', t.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.invoices).toHaveLength(1);
    const detail = await request(app)
      .get(`/orgs/${t.orgId}/invoices/${rows[0]?.id}`)
      .set('Authorization', t.auth);
    expect(detail.status).toBe(200);
    const lines = detail.body.data.lines as Array<{ kind: string; quantity: number; amountMicros: string }>;
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.kind === 'message_costs')).toMatchObject({
      quantity: 2,
      amountMicros: (2n * RATE).toString(),
    });
    expect(lines.find((l) => l.kind === 'platform_fee')).toMatchObject({
      quantity: 1,
      amountMicros: FEE.toString(),
    });

    // An outsider cannot read it.
    const outsider = await tenant();
    const cross = await request(app)
      .get(`/orgs/${t.orgId}/invoices/${rows[0]?.id}`)
      .set('Authorization', outsider.auth);
    expect([403, 404]).toContain(cross.status);

    // Re-running the close is a no-op, not a second document and not an edit.
    const rerun = await billingService.closePeriod({ orgId: t.orgId, periodStart: LAST_MONTH });
    expect(rerun.outcome).toBe('already_closed');
    const after = await invoicesOf(t.orgId);
    expect(after).toHaveLength(1);
    expect(after[0]?.total_micros).toBe((2n * RATE + FEE).toString());

    // And the document is immutable at the database, not by convention.
    await expect(
      db
        .updateTable('commerce_invoices')
        .set({ total_micros: '1' })
        .where('id', '=', after[0]?.id ?? '')
        .execute(),
    ).rejects.toThrow(/immutable after issue/);
  });

  it('an unpriced message holds every invoice of its period at draft until the backfill heals it', async () => {
    const t = await tenant();
    const rated = await sentMessage(t);
    await rateAsMarketing(t, rated);
    await ageIntoLastMonth(rated.messageId);
    // Went out, no receipt yet: `billable` NULL, status sent — the honest "Meta has not said".
    const silent = await sentMessage(t);
    await ageIntoLastMonth(silent.messageId);

    const first = await billingService.closePeriod({ orgId: t.orgId, periodStart: LAST_MONTH });
    expect(first.outcome).toBe('still_open');
    const drafts = await invoicesOf(t.orgId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.status).toBe('draft');
    const draftRow = await db
      .selectFrom('commerce_invoices')
      .select(['unpriced_messages'])
      .where('id', '=', drafts[0]?.id ?? '')
      .executeTakeFirstOrThrow();
    expect(draftRow.unpriced_messages).toBe(1);

    // The receipt lands (late), the backfill prices it — into the OPEN month, by design.
    await db
      .updateTable('commerce_messages')
      .set({ billable: true, pricing_category: 'marketing', status: 'delivered' })
      .where('id', '=', silent.messageId)
      .execute();
    const outcome = await messageCostBackfillHandler.handle(
      jobFor(t.orgId, 'message_cost_backfill', {}),
    );
    expect(outcome.kind).toBe('done');
    const healed = await db
      .selectFrom('commerce_message_costs')
      .select(['state', 'amount_micros', 'priced_at'])
      .where('message_id', '=', silent.messageId)
      .executeTakeFirstOrThrow();
    expect(healed).toMatchObject({ state: 'rated', amount_micros: RATE.toString() });
    expect(healed.priced_at.toISOString().slice(0, 7)).toBe(THIS_MONTH.slice(0, 7));

    // Now the period is complete — and the issued invoice carries LAST month's money only.
    const second = await billingService.closePeriod({ orgId: t.orgId, periodStart: LAST_MONTH });
    expect(second.outcome).toBe('closed');
    const issued = await invoicesOf(t.orgId);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ status: 'issued', total_micros: RATE.toString() });
  });

  it('an unrated message holds its period open, without churning, until the missing rate is loaded', async () => {
    const t = await tenant();
    const rated = await sentMessage(t, '1');
    await rateAsMarketing(t, rated);
    await ageIntoLastMonth(rated.messageId);
    // Country 44 has no price on the live card: the rater refuses, on the record.
    const unpriceable = await sentMessage(t, '44');
    await rateAsMarketing(t, unpriceable);
    await ageIntoLastMonth(unpriceable.messageId);
    const before = await db
      .selectFrom('commerce_message_costs')
      .select(['state', 'priced_at'])
      .where('message_id', '=', unpriceable.messageId)
      .executeTakeFirstOrThrow();
    expect(before.state).toBe('unrated_no_rate');

    const first = await billingService.closePeriod({ orgId: t.orgId, periodStart: LAST_MONTH });
    expect(first.outcome).toBe('still_open');

    // A backfill pass with the rate STILL missing must leave the row exactly where it is — a
    // rewrite would stamp a fresh priced_at and walk the discrepancy out of the period it belongs to.
    await messageCostBackfillHandler.handle(jobFor(t.orgId, 'message_cost_backfill', {}));
    const untouched = await db
      .selectFrom('commerce_message_costs')
      .select(['state', 'priced_at'])
      .where('message_id', '=', unpriceable.messageId)
      .executeTakeFirstOrThrow();
    expect(untouched.state).toBe('unrated_no_rate');
    expect(untouched.priced_at.getTime()).toBe(before.priced_at.getTime());

    // The operator loads the corrected card; the backfill prices the message into the open month.
    const card2 = await rateCardRepository.loadCard({
      currency: CUR,
      effectiveFrom: new Date('2020-06-01T00:00:00Z'),
      sourceNote: 'billing suite sheet, corrected — country 44 added',
      loadedByUserId: operatorId,
      rates: [
        { countryCallingCode: '1', pricingCategory: 'marketing', amountMicros: RATE, unit: 'per_message' },
        { countryCallingCode: '44', pricingCategory: 'marketing', amountMicros: RATE_44, unit: 'per_message' },
      ],
    });
    createdCards.push(card2.id);
    await messageCostBackfillHandler.handle(jobFor(t.orgId, 'message_cost_backfill', {}));
    const reRated = await db
      .selectFrom('commerce_message_costs')
      .select(['state', 'amount_micros', 'priced_at'])
      .where('message_id', '=', unpriceable.messageId)
      .executeTakeFirstOrThrow();
    expect(reRated).toMatchObject({ state: 'rated', amount_micros: RATE_44.toString() });
    expect(reRated.priced_at.toISOString().slice(0, 7)).toBe(THIS_MONTH.slice(0, 7));

    // The stuck month closes; its invoice carries only the money that was PRICED inside it.
    const second = await billingService.closePeriod({ orgId: t.orgId, periodStart: LAST_MONTH });
    expect(second.outcome).toBe('closed');
    const issued = await invoicesOf(t.orgId);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ status: 'issued', total_micros: RATE.toString() });
  });

  it('a subscription with no message traffic still bills its flat fee', async () => {
    const t = await tenant();
    const created = await billingService.upsertPlan({
      name: `Quiet ${randomUUID().slice(0, 8)}`,
      platformFeeMicros: FEE.toString(),
      currency: CUR,
      note: 'flat',
      createdByUserId: operatorId,
    });
    createdPlans.push(created.plan.id);
    await billingService.setSubscription({
      orgId: t.orgId,
      planId: created.plan.id,
      note: 'signed',
      createdByUserId: operatorId,
    });
    await backdateSubscription(t.orgId);

    const result = await billingService.closePeriod({ orgId: t.orgId, periodStart: LAST_MONTH });
    expect(result.outcome).toBe('closed');
    const rows = await invoicesOf(t.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'issued', total_micros: FEE.toString() });
    const lines = await db
      .selectFrom('commerce_invoice_lines')
      .select(['kind'])
      .where('invoice_id', '=', rows[0]?.id ?? '')
      .execute();
    expect(lines.map((l) => l.kind)).toEqual(['platform_fee']);
  });

  it('releases a reservation whose receipt never came — and still books the charge if one arrives later', async () => {
    const t = await tenant();
    await spendCapRepository.setCap({
      orgId: t.orgId,
      currency: CUR,
      limitMicros: 100n * RATE,
      grantedByUserId: t.userId,
      note: 'billing suite headroom',
    });
    const m = await sentMessage(t);
    await spendCapRepository.reserve({
      orgId: t.orgId,
      currency: CUR,
      amountMicros: RATE,
      messageId: m.messageId,
      broadcastId: null,
      at: new Date(),
    });
    // Eight days of silence: older than the staleness window, receipt still absent.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await sql`UPDATE commerce_messages SET created_at = ${eightDaysAgo} WHERE id = ${m.messageId}`.execute(db);

    await messageCostBackfillHandler.handle(jobFor(t.orgId, 'message_cost_backfill', {}));
    const period = await db
      .selectFrom('commerce_spend_periods')
      .select(['reserved_micros', 'actual_micros'])
      .where('org_id', '=', t.orgId)
      .where('currency', '=', CUR)
      .executeTakeFirstOrThrow();
    expect(period).toMatchObject({ reserved_micros: '0', actual_micros: '0' });
    const closings = await db
      .selectFrom('commerce_spend_ledger')
      .select(['kind'])
      .where('message_id', '=', m.messageId)
      .where('kind', 'in', ['release', 'settle'])
      .execute();
    expect(closings.map((c) => c.kind)).toEqual(['release']);

    // The receipt limps in on day nine. The hold is long gone; the CHARGE must not be.
    await rateAsMarketing(t, m);
    const settled = await db
      .selectFrom('commerce_spend_periods')
      .select(['reserved_micros', 'actual_micros'])
      .where('org_id', '=', t.orgId)
      .where('currency', '=', CUR)
      .orderBy('period_start', 'desc')
      .execute();
    const totalActual = settled.reduce((sum, p) => sum + BigInt(p.actual_micros), 0n);
    expect(totalActual).toBe(RATE);

    // A replayed receipt cannot book it twice.
    await costRatingService.rateMessage({
      orgId: t.orgId,
      messageId: m.messageId,
      conversationId: m.conversationId,
      billable: true,
      pricingCategory: 'marketing',
      providerConversationId: null,
      billingCurrency: CUR,
    });
    const again = await db
      .selectFrom('commerce_spend_periods')
      .select(['actual_micros'])
      .where('org_id', '=', t.orgId)
      .where('currency', '=', CUR)
      .execute();
    expect(again.reduce((sum, p) => sum + BigInt(p.actual_micros), 0n)).toBe(RATE);
  });
});
