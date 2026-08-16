import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';
import type { SegmentDefinition } from '@stewra/shared-types';

/**
 * DUNNING — what happens to an org that has not paid.
 *
 * The spend cap bounds how MUCH an org may spend; this bounds how LONG it may keep spending without
 * settling. Both are needed, and the gap between them is the exposure: a cap granted to a paying
 * client keeps working perfectly after that client stops paying.
 *
 * The policy is a 7-day grace window measured from `issued_at`, then billable sending stops. The
 * state is derived, never stored — see dunningService for why a `past_due` column would be the
 * wrong shape. What this suite pins down is that the derivation is right at every boundary, that
 * the warning state really does leave sending alone (a grace period nobody is told about is not a
 * grace period), and that a campaign scheduled inside the window and dispatched outside it stops.
 */

const APP_ID = '100000000000001';
const APP_HMAC = randomBytes(32).toString('hex');

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const graph: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname.replace(/^\/v\d+\.\d+\//, '');
  if (pathname.endsWith('/messages') && req.method === 'POST') {
    // Drained but not inspected: this suite never asserts on what was sent, only on whether
    // sending was allowed to start. The listener still has to consume the body — an unread
    // request stream leaves the socket open and the server never closes in afterAll.
    req.resume();
    req.on('end', () => {
      json(res, 200, { messages: [{ id: `wamid.${randomUUID()}` }] });
    });
    return;
  }
  json(res, 404, { error: { message: `unscripted graph path: ${req.method} ${pathname}` } });
});

await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
const graphOrigin = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;

process.env['META_COMMERCE_ENABLED'] = 'true';
process.env['META_COMMERCE_APP_ID'] = APP_ID;
process.env['META_COMMERCE_APP_SECRET'] = APP_HMAC;
process.env['META_COMMERCE_CONFIG_ID'] = '200000000000002';
process.env['META_COMMERCE_VERIFY_TOKEN'] = `verify-${randomBytes(8).toString('hex')}`;
process.env['META_COMMERCE_GRAPH_BASE_URL'] = graphOrigin;

const database = (await import('../database/index.js')) as {
  db: typeof dbType;
  closeDb: typeof closeDbType;
};
const { db } = database;
const { organizationRepository } = await import(
  '../commerce/repositories/organizationRepository.js'
);
const { channelAccountRepository } = await import(
  '../commerce/repositories/channelAccountRepository.js'
);
const { templateRepository } = await import('../commerce/repositories/templateRepository.js');
const { commerceInboxRepository } = await import(
  '../commerce/repositories/commerceInboxRepository.js'
);
const { contactRepository } = await import('../commerce/repositories/contactRepository.js');
const { consentRepository } = await import('../commerce/repositories/consentRepository.js');
const { rateCardRepository } = await import('../commerce/repositories/rateCardRepository.js');
const { spendCapRepository } = await import('../commerce/repositories/spendCapRepository.js');
const { broadcastService } = await import('../commerce/services/broadcastService.js');
const { audienceService } = await import('../commerce/services/audienceService.js');
const { consentService } = await import('../commerce/services/consentService.js');
const { dunningService, DUNNING_GRACE_DAYS } = await import(
  '../commerce/services/dunningService.js'
);
const { commerceWorker } = await import('../commerce/jobs/worker.js');
const { vault } = await import('../control-plane/vault/vault.js');
const { PaymentRequiredError } = await import('../utils/errors.js');

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdOrgs: string[] = [];
const createdUsers: string[] = [];
const createdSecrets: string[] = [];
const createdCards: string[] = [];

// A never-real currency, so this suite's rate card cannot collide with another suite's.
const CUR = `Y${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}`;
const DAY_MS = 86_400_000;

function hhmmFromNow(offsetMinutes: number): string {
  const when = new Date(Date.now() + offsetMinutes * 60_000);
  return `${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}`;
}

interface Tenant {
  readonly orgId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly segmentId: string;
  readonly templateId: string;
  readonly tag: string;
}

async function createUser(email: string): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({
      email,
      display_name: 'Dunning Tester',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

/** An org that can send: headroom granted, so the ONLY gate left under test is dunning. */
async function tenant(): Promise<Tenant> {
  const userId = await createUser(`dunning-${randomUUID()}@stewra.invalid`);
  const { org } = await organizationRepository.create({
    name: 'Dunning Test Org',
    slug: `dunning-${randomUUID().slice(0, 12)}`,
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
    displayName: 'Dunning Test Number',
    displayPhoneNumber: null,
    credentialRef,
    credentialExpiresAt: null,
    billingCurrency: CUR,
    meta: {},
  });

  await consentService.setQuietHours({
    orgId: org.id,
    timezone: 'UTC',
    quietHoursStart: hhmmFromNow(120),
    quietHoursEnd: hhmmFromNow(121),
  });
  await consentService.attest({
    orgId: org.id,
    attestedByUserId: userId,
    attestationText: 'We hold documented opt-in for every contact on this list.',
  });

  const tag = `dun-${randomUUID().slice(0, 8)}`;
  const segment = await audienceService.createSegment({
    orgId: org.id,
    name: `Segment ${randomUUID().slice(0, 8)}`,
    description: null,
    definition: { match: 'all', rules: [{ type: 'tag', op: 'has', tag }] } satisfies SegmentDefinition,
    createdByUserId: userId,
  });

  const template = await templateRepository.upsertFromMeta({
    orgId: org.id,
    channelAccountId: account.id,
    name: 'dunning_offer',
    language: 'en_US',
    category: 'marketing',
    providerCategory: 'MARKETING',
    status: 'approved',
    providerStatus: 'APPROVED',
    providerTemplateId: `tpl-${randomUUID().slice(0, 8)}`,
    headerText: null,
    bodyText: 'Hi {{1}}, our offer ends soon.',
    footerText: null,
    variableCount: 1,
    rejectionReason: null,
    qualityScore: null,
  });

  await spendCapRepository.setCap({
    orgId: org.id,
    currency: CUR,
    limitMicros: 1_000_000n,
    grantedByUserId: userId,
    note: 'dunning suite: headroom is not what is being tested',
  });

  return {
    orgId: org.id,
    userId,
    accountId: account.id,
    segmentId: segment.id,
    templateId: template.id,
    tag,
  };
}

let invoiceSerial = 0;
let contactSerial = 0;
async function contact(t: Tenant): Promise<void> {
  contactSerial += 1;
  const phone = `1556${String(3_000_000 + contactSerial * 17 + Math.floor(Math.random() * 11))}`;
  const contactId = await commerceInboxRepository.upsertContact({
    orgId: t.orgId,
    platform: 'whatsapp_cloud',
    externalId: phone,
    displayName: 'Dunning Target',
    phoneE164: `+${phone}`,
  });
  const tagRow = await contactRepository.upsertTag(t.orgId, t.tag);
  await contactRepository.attachTag(t.orgId, contactId, tagRow.id);
  await consentRepository.recordConsent({
    orgId: t.orgId,
    contactId,
    platform: 'whatsapp_cloud',
    purpose: 'marketing',
    state: 'opted_in',
    source: 'web_form',
    evidence: `https://example.invalid/form/${randomUUID()}`,
    recordedByUserId: t.userId,
  });
}

/**
 * An invoice that issued `daysAgo` days ago and has not been paid.
 *
 * Inserted at `issued` directly. The table's trigger makes an issued row immutable, so it cannot be
 * built as a draft and then backdated — and backdating `issued_at` after the fact is precisely what
 * the trigger exists to prevent. Writing the row in its final state is the only honest way to stage
 * a history that a real close job would have produced weeks ago.
 */
async function unpaidInvoice(orgId: string, daysAgo: number): Promise<string> {
  const issuedAt = new Date(Date.now() - daysAgo * DAY_MS);
  // One invoice per (org, currency, period) is a real uniqueness rule — it is the close job's
  // idempotency guarantee — so a test that wants two outstanding invoices has to put them in two
  // periods. Walked back a month at a time from a fixed base rather than derived from `issuedAt`:
  // two invoices 12 days and 1 day old usually fall in the same calendar month, and "usually" is
  // how a suite ends up passing everywhere except the first week of the month.
  invoiceSerial += 1;
  const periodStart = new Date(Date.UTC(2024, 0, 1));
  periodStart.setUTCMonth(periodStart.getUTCMonth() + invoiceSerial);
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  const row = await db
    .insertInto('commerce_invoices')
    .values({
      org_id: orgId,
      currency: CUR,
      period_start: periodStart.toISOString().slice(0, 10),
      period_end: periodEnd.toISOString().slice(0, 10),
      status: 'issued',
      total_micros: '25000',
      issued_at: issuedAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function schedule(t: Tenant, name: string): Promise<string> {
  const broadcast = await broadcastService.create({
    orgId: t.orgId,
    createdByUserId: t.userId,
    name,
    channelAccountId: t.accountId,
    segmentId: t.segmentId,
    templateId: t.templateId,
    variables: ['there'],
    scheduledFor: new Date(Date.now() - 1000),
  });
  return broadcast.id;
}

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
      .where('org_id', '=', orgId)
      .where('status', '=', 'queued')
      .execute();
    await commerceWorker.runOnce();
  }
  throw new Error(`jobs for ${orgId} did not drain in ${maxPasses} passes`);
}

beforeAll(async () => {
  await db.deleteFrom('commerce_jobs').execute();
  const loaderId = await createUser(`dunning-loader-${randomUUID()}@stewra.invalid`);
  const card = await rateCardRepository.loadCard({
    currency: CUR,
    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    sourceNote: 'dunning suite sheet',
    loadedByUserId: loaderId,
    rates: [
      { countryCallingCode: '1', pricingCategory: 'marketing', amountMicros: 1_000n, unit: 'per_message' },
    ],
  });
  createdCards.push(card.id);
});

afterAll(async () => {
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  for (const ref of createdSecrets) {
    await vault.delete(ref);
  }
  if (createdOrgs.length > 0) {
    await db.deleteFrom('commerce_jobs').where('org_id', 'in', createdOrgs).execute();
    // Issued invoices refuse DELETE by trigger, and so do their lines once the invoice issues.
    // Lifted only here, and said out loud, so the harness borrows the rule rather than the schema
    // losing it.
    //
    // The line delete is scoped to THIS suite's invoices. It used to have no WHERE clause at all,
    // which meant every invoice line in the test database, belonging to any suite. That was
    // invisible while this file was the only thing that created invoices; the browser billing suite
    // now creates real issued ones too, and the unscoped delete promptly failed against the lines
    // trigger it did not think to disable. A teardown in a shared database has no business reaching
    // past its own rows.
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_invoices DISABLE TRIGGER trg_commerce_invoices_issued_immutable`.execute(trx);
      await sql`ALTER TABLE commerce_invoice_lines DISABLE TRIGGER trg_commerce_invoice_lines_draft_only`.execute(trx);
      await trx
        .deleteFrom('commerce_invoice_lines')
        .where('invoice_id', 'in', (eb) =>
          eb.selectFrom('commerce_invoices').select('id').where('org_id', 'in', createdOrgs),
        )
        .execute();
      await trx.deleteFrom('commerce_invoices').where('org_id', 'in', createdOrgs).execute();
      await sql`ALTER TABLE commerce_invoice_lines ENABLE TRIGGER trg_commerce_invoice_lines_draft_only`.execute(trx);
      await sql`ALTER TABLE commerce_invoices ENABLE TRIGGER trg_commerce_invoices_issued_immutable`.execute(trx);
    });
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_spend_ledger DISABLE TRIGGER stewra_commerce_spend_ledger_append_only`.execute(trx);
      await trx.deleteFrom('commerce_spend_ledger').where('org_id', 'in', createdOrgs).execute();
      await sql`ALTER TABLE commerce_spend_ledger ENABLE TRIGGER stewra_commerce_spend_ledger_append_only`.execute(trx);
    });
    await db.deleteFrom('commerce_spend_periods').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_spend_caps').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_message_costs').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_broadcast_recipients').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_broadcasts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_messages').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_conversations').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_templates').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_segments').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_contact_tags').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_tags').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_messaging_policies').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_suppressions').where('org_id', 'in', createdOrgs).execute();
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_contact_consents DISABLE TRIGGER trg_commerce_consents_append_only`.execute(trx);
      await trx.deleteFrom('commerce_contact_consents').where('org_id', 'in', createdOrgs).execute();
      await sql`ALTER TABLE commerce_contact_consents ENABLE TRIGGER trg_commerce_consents_append_only`.execute(trx);
    });
    await db.deleteFrom('commerce_contacts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('channel_accounts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
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

describe('the three states', () => {
  it('an org with nothing outstanding is current, and sends', async () => {
    const t = await tenant();
    await contact(t);

    const standing = await dunningService.delinquency(t.orgId);
    expect(standing.state).toBe('current');
    expect(standing.daysOutstanding).toBe(0);
    expect(standing.outstandingInvoiceIds).toHaveLength(0);

    await expect(schedule(t, 'Nothing owed')).resolves.toBeTruthy();
  });

  it('inside the grace window it warns, and STILL sends', async () => {
    const t = await tenant();
    await contact(t);
    const invoiceId = await unpaidInvoice(t.orgId, 3);

    const standing = await dunningService.delinquency(t.orgId);
    expect(standing.state).toBe('warning');
    expect(standing.daysOutstanding).toBe(3);
    expect(standing.graceDays).toBe(DUNNING_GRACE_DAYS);
    expect(standing.outstandingInvoiceIds).toEqual([invoiceId]);

    // The point of the whole state. A grace period that quietly stopped sending would be a hard
    // stop with extra steps, and the client would learn about the invoice from a failed campaign.
    await expect(schedule(t, 'Owed but in grace')).resolves.toBeTruthy();
  });

  it('past the grace window it refuses, with 402 and a code that names the reason', async () => {
    const t = await tenant();
    await contact(t);
    await unpaidInvoice(t.orgId, DUNNING_GRACE_DAYS + 2);

    const standing = await dunningService.delinquency(t.orgId);
    expect(standing.state).toBe('delinquent');

    const error = await schedule(t, 'Owed too long').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentRequiredError);
    expect((error as InstanceType<typeof PaymentRequiredError>).statusCode).toBe(402);
    expect((error as InstanceType<typeof PaymentRequiredError>).code).toBe('PAST_DUE');

    // Refused means not enqueued: nothing is waiting to march to a pause.
    const jobs = await db
      .selectFrom('commerce_jobs')
      .select('id')
      .where('org_id', '=', t.orgId)
      .execute();
    expect(jobs).toHaveLength(0);
  });

  it('the boundary day is still inside the window, not outside it', async () => {
    // Exactly at the grace length is the last allowed day — `> graceDays`, not `>=`. Worth pinning:
    // an off-by-one here cuts a paying client off a day early, and the message would still read
    // "past the 7-day grace period" while the invoice was 7 days old.
    const t = await tenant();
    await contact(t);
    await unpaidInvoice(t.orgId, DUNNING_GRACE_DAYS);

    const standing = await dunningService.delinquency(t.orgId);
    expect(standing.daysOutstanding).toBe(DUNNING_GRACE_DAYS);
    expect(standing.state).toBe('warning');
    await expect(schedule(t, 'Last day of grace')).resolves.toBeTruthy();
  });

  it('measures from the OLDEST unpaid invoice, not the newest', async () => {
    // Otherwise a client who lets an old invoice rot buys a fresh grace window every month simply
    // by being invoiced again.
    const t = await tenant();
    await contact(t);
    const old = await unpaidInvoice(t.orgId, DUNNING_GRACE_DAYS + 5);
    const recent = await unpaidInvoice(t.orgId, 1);

    const standing = await dunningService.delinquency(t.orgId);
    expect(standing.state).toBe('delinquent');
    expect(standing.daysOutstanding).toBe(DUNNING_GRACE_DAYS + 5);
    expect(standing.outstandingInvoiceIds).toEqual([old, recent]);
  });

  it('paying clears it, and sending resumes', async () => {
    const t = await tenant();
    await contact(t);
    const invoiceId = await unpaidInvoice(t.orgId, DUNNING_GRACE_DAYS + 3);
    await expect(schedule(t, 'Blocked')).rejects.toBeInstanceOf(PaymentRequiredError);

    // issued -> paid is the one transition the invoice trigger allows, so this is the real path.
    await db
      .updateTable('commerce_invoices')
      .set({ status: 'paid', updated_at: new Date() })
      .where('id', '=', invoiceId)
      .execute();

    expect((await dunningService.delinquency(t.orgId)).state).toBe('current');
    await expect(schedule(t, 'Unblocked')).resolves.toBeTruthy();
  });

  it('a voided invoice is not owed', async () => {
    const t = await tenant();
    await contact(t);
    const invoiceId = await unpaidInvoice(t.orgId, DUNNING_GRACE_DAYS + 9);
    await db
      .updateTable('commerce_invoices')
      .set({ status: 'void', updated_at: new Date() })
      .where('id', '=', invoiceId)
      .execute();

    expect((await dunningService.delinquency(t.orgId)).state).toBe('current');
  });

  it('a draft invoice is not owed — it has not been billed yet', async () => {
    const t = await tenant();
    const periodStart = new Date(Date.UTC(2024, 0, 1));
    await db
      .insertInto('commerce_invoices')
      .values({
        org_id: t.orgId,
        currency: CUR,
        period_start: periodStart.toISOString().slice(0, 10),
        period_end: new Date(Date.UTC(2024, 1, 1)).toISOString().slice(0, 10),
        status: 'draft',
        total_micros: '90000',
      })
      .execute();

    expect((await dunningService.delinquency(t.orgId)).state).toBe('current');
  });
});

describe('a campaign that outlives the grace window', () => {
  it('pauses at dispatch, with no retry enqueued', async () => {
    const t = await tenant();
    await contact(t);

    // Scheduled while the org was still inside the window...
    const broadcastId = await schedule(t, 'Scheduled in grace, dispatched late');
    await unpaidInvoice(t.orgId, DUNNING_GRACE_DAYS + 1);

    // ...and dispatched after it closed. The create-time gate cannot cover this; the job must.
    await drainJobs(t.orgId);

    const broadcast = await broadcastService.get(t.orgId, broadcastId);
    expect(broadcast.status).toBe('paused');
    expect(broadcast.lastError).toContain('grace period');

    // An unpaid invoice does not become paid by waiting, so a retry would only pause again.
    const queued = await db
      .selectFrom('commerce_jobs')
      .select('id')
      .where('org_id', '=', t.orgId)
      .where('status', 'in', ['queued', 'running'])
      .execute();
    expect(queued).toHaveLength(0);

    // And resume refuses for the same reason, rather than putting it back to be paused again.
    await expect(broadcastService.resume(t.orgId, broadcastId)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
  });
});
