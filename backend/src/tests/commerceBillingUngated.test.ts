import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';

/**
 * Billing runs when WhatsApp does not.
 *
 * This suite exists because it did not. `enqueueBillingPeriodCloses` and `enqueueInvoiceCharges`
 * both opened with `if (!config.metaCommerce.enabled) return 0`, and `startCommerceScheduler`
 * returned before starting anything at all — so on an install with no Meta app credentials, no
 * invoice was ever issued and no invoice was ever collected.
 *
 * Three reasons that was wrong, in increasing order of how expensive it is:
 *
 *  1. The platform fee is a FLAT MONTHLY fee. It is owed whether or not the organization ever sends
 *     a WhatsApp message, and issuing the invoice involves no third party at all.
 *  2. A subscription bought in the App Store or on Google Play has nothing whatsoever to do with
 *     Meta. Selling only subscriptions is a complete product, and it billed nobody.
 *  3. It failed in the direction that GRANTS FREE CREDIT. Nobody files a ticket saying they were
 *     not charged, so it runs until someone reconciles a bank statement by hand.
 *
 * The flag is pinned false at module scope for the same reason `commerceBroadcastsDisabled` pins
 * it: sibling commerce suites set it to 'true', and `process.env` outlives a module registry reset,
 * so a file that merely declined to set it would assert the opposite of its name depending on which
 * suite happened to run first.
 */
process.env['META_COMMERCE_ENABLED'] = 'false';

const { db, closeDb } = await import('../database/index.js');
const { config } = await import('../config/unifiedConfig.js');
const { billingService } = await import('../commerce/services/billingService.js');
const { enqueueBillingPeriodCloses } = await import(
  '../commerce/jobs/billingPeriodCloseHandler.js'
);
const { enqueueInvoiceCharges } = await import('../commerce/jobs/invoiceChargeHandler.js');

const CUR = 'USD';
const FEE = '149000000';

let orgId = '';
let userId = '';
let planId = '';

/** First of the current month, UTC — the period billing in advance closes. */
function currentPeriodStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

beforeAll(async () => {
  // The guard under test only fires when the flag is false, so a run that inherited 'true' from a
  // sibling would pass while proving nothing. Assert the premise rather than trust it.
  expect(config.metaCommerce.enabled).toBe(false);

  const user = await db
    .insertInto('users')
    .values({
      email: `billing-ungated-${randomUUID()}@stewra.invalid`,
      password_hash: await bcrypt.hash(`Pw!${randomUUID()}`, 4),
      display_name: 'Billing Ungated',
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  userId = user.id;

  const org = await db
    .insertInto('organizations')
    .values({
      kind: 'business',
      name: `Ungated Billing ${randomUUID().slice(0, 8)}`,
      slug: `ungated-billing-${randomUUID().slice(0, 8)}`,
      created_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  orgId = org.id;

  const plan = await billingService.upsertPlan({
    name: `Ungated Plan ${randomUUID().slice(0, 8)}`,
    platformFeeMicros: FEE,
    currency: CUR,
    note: 'billing-ungated suite: a plan that must bill without any Meta credential',
    createdByUserId: userId,
  });
  planId = plan.plan.id;

  await billingService.setSubscription({
    orgId,
    planId,
    collector: 'stewra_stripe',
    note: 'billing-ungated suite',
    createdByUserId: userId,
  });

  // In force before the month began — the fee is charged in advance, so a subscription that started
  // today is legitimately free until the 1st and would prove nothing here.
  await sql`
    UPDATE commerce_subscriptions
       SET started_at = date_trunc('month', now() AT TIME ZONE 'utc') - interval '1 day'
     WHERE org_id = ${orgId} AND ended_at IS NULL
  `.execute(db);
});

afterAll(async () => {
  await db.deleteFrom('commerce_jobs').where('org_id', '=', orgId).execute();
  await db.transaction().execute(async (trx) => {
    await sql`ALTER TABLE commerce_invoice_lines DISABLE TRIGGER trg_commerce_invoice_lines_draft_only`.execute(trx);
    await sql`ALTER TABLE commerce_invoices DISABLE TRIGGER trg_commerce_invoices_issued_immutable`.execute(trx);
    await trx
      .deleteFrom('commerce_invoice_lines')
      .where('invoice_id', 'in', (eb) =>
        eb.selectFrom('commerce_invoices').select('id').where('org_id', '=', orgId),
      )
      .execute();
    await trx.deleteFrom('commerce_invoices').where('org_id', '=', orgId).execute();
    await sql`ALTER TABLE commerce_invoices ENABLE TRIGGER trg_commerce_invoices_issued_immutable`.execute(trx);
    await sql`ALTER TABLE commerce_invoice_lines ENABLE TRIGGER trg_commerce_invoice_lines_draft_only`.execute(trx);
  });
  await db.deleteFrom('commerce_billing_periods').where('org_id', '=', orgId).execute();
  await db.deleteFrom('commerce_subscriptions').where('org_id', '=', orgId).execute();
  await db.transaction().execute(async (trx) => {
    await sql`ALTER TABLE commerce_plan_versions DISABLE TRIGGER trg_commerce_plan_versions_append_only`.execute(trx);
    await trx.deleteFrom('commerce_plan_versions').where('plan_id', '=', planId).execute();
    await sql`ALTER TABLE commerce_plan_versions ENABLE TRIGGER trg_commerce_plan_versions_append_only`.execute(trx);
  });
  await db.deleteFrom('commerce_plans').where('id', '=', planId).execute();
  await db.deleteFrom('organizations').where('id', '=', orgId).execute();
  await db.deleteFrom('users').where('id', '=', userId).execute();
  await closeDb();
});

describe('billing with META_COMMERCE_ENABLED=false', () => {
  it('still queues the period close for a subscribed org', async () => {
    const enqueued = await enqueueBillingPeriodCloses();
    expect(enqueued).toBeGreaterThan(0);

    const job = await db
      .selectFrom('commerce_jobs')
      .select(['kind', 'org_id'])
      .where('org_id', '=', orgId)
      .where('kind', '=', 'billing_period_close')
      .executeTakeFirst();
    expect(job).toBeDefined();
  });

  it('bills the period for real, producing the invoice the customer owes', async () => {
    const result = await billingService.closePeriod({
      orgId,
      periodStart: currentPeriodStart(),
    });

    expect(result.outcome).toBe('closed');
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]?.totalMicros).toBe(FEE);
    expect(result.invoices[0]?.currency).toBe(CUR);
    // Issued, not draft: a flat fee is fully known the moment its period begins, so there is
    // nothing outstanding that would justify holding it back.
    expect(result.invoices[0]?.status).toBe('issued');
  });

  it('declines to collect for the provider, not for the Meta flag', async () => {
    // The install runs `manual` in the test environment, so nothing is enqueued — and the REASON
    // must be the billing provider. If a future edit reintroduces a Meta gate here this assertion
    // still reads zero and would not catch it, which is exactly why the two tests above exist:
    // together they pin that the pipeline runs and stops only where money actually moves.
    expect(config.commerceBilling.provider).toBe('manual');
    await expect(enqueueInvoiceCharges()).resolves.toBe(0);
  });
});
