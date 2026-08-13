import { randomBytes, randomUUID } from 'node:crypto';
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
import type { SegmentDefinition } from '@stewra/shared-types';

/**
 * SPEND CAPS (migration 052) — the tables and gates that make "an org cannot run up unbounded Meta
 * cost on this install" true, with the platform's default applied: **zero third-party spend until
 * headroom is granted**.
 *
 * The centerpiece drives a 60-recipient campaign through the REAL dispatch→send chain against
 * headroom for one and a half batches, and pins the properties a shortcut would fake: sends stop
 * exactly where the money stops, no send happens without a reservation behind it, nobody is left
 * half-claimed, NO retry is enqueued (a cap does not clear on its own), and raising the cap +
 * resume finishes the campaign without messaging anyone twice.
 */

const APP_ID = '100000000000001';
const APP_HMAC = randomBytes(32).toString('hex');

/** Recipient numbers Meta will refuse next, with a per-number error. */
let refuseNumbers: Set<string> = new Set();
/** Every send Meta accepted: the recipient and the wamid it was given. */
const acceptedSends: Array<{ to: string; wamid: string }> = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const graph: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname.replace(/^\/v\d+\.\d+\//, '');
  if (pathname.endsWith('/messages') && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const payload = JSON.parse(raw) as { to: string };
      if (refuseNumbers.has(payload.to)) {
        json(res, 400, { error: { message: 'Recipient phone number not valid', code: 131026 } });
        return;
      }
      const wamid = `wamid.${randomUUID()}`;
      acceptedSends.push({ to: payload.to, wamid });
      json(res, 200, { messages: [{ id: wamid }] });
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
const { config } = await import('../config/unifiedConfig.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const orgRoutes = (await import('../commerce/routes/organizations.js')).default;
const spendCapRoutes = (await import('../commerce/routes/spendCaps.js')).default;
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
const { commerceInboundService } = await import(
  '../commerce/services/commerceInboundService.js'
);
const { whatsappInboundAdapter } = await import(
  '../commerce/services/inbound/whatsappAdapter.js'
);
const { commerceWorker } = await import('../commerce/jobs/worker.js');
const { vault } = await import('../control-plane/vault/vault.js');
const { ForbiddenError } = await import('../utils/errors.js');

const app = express();
app.use(express.json());
app.use('/orgs', orgRoutes);
app.use('/platform/spend-caps', spendCapRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdOrgs: string[] = [];
const createdUsers: string[] = [];
const createdSecrets: string[] = [];
const createdCards: string[] = [];

// One live card per currency install-wide; a never-real currency keeps this suite out of every
// other suite's way, and out of its own past runs' way.
const CUR = `Z${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}`;
/** Micros one marketing message to country 1 costs on this suite's card. */
const RATE = 1_000n;

// The second address in the test INSTALL_ADMIN_EMAILS list — the first belongs to the rates suite,
// and two suites racing to create the same unique email would fail each other.
const OPERATOR_EMAIL = 'spend-cap-admin@stewra.test';

function hhmmFromNow(offsetMinutes: number): string {
  const when = new Date(Date.now() + offsetMinutes * 60_000);
  return `${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}`;
}

interface Tenant {
  readonly orgId: string;
  readonly userId: string;
  readonly auth: string;
  readonly accountId: string;
  readonly wabaId: string;
  readonly segmentId: string;
  readonly templateId: string;
  readonly tag: string;
}

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
      display_name: 'Spend Cap Tester',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

/** An org one call away from sending — everything a campaign needs EXCEPT a spend cap. */
async function tenant(): Promise<Tenant> {
  const userId = await createUser(`spend-cap-${randomUUID()}@stewra.invalid`);
  const { org } = await organizationRepository.create({
    name: 'Spend Cap Test Org',
    slug: `spendcap-${randomUUID().slice(0, 12)}`,
    createdBy: userId,
  });
  createdOrgs.push(org.id);

  const credentialRef = await vault.put(`test-token-${randomUUID()}`);
  createdSecrets.push(credentialRef);
  const wabaId = `waba-${randomUUID().slice(0, 12)}`;
  const { account } = await channelAccountRepository.upsert({
    orgId: org.id,
    platform: 'whatsapp_cloud',
    externalAccountId: wabaId,
    phoneNumberId: `pn-${randomUUID().slice(0, 12)}`,
    displayName: 'Spend Cap Test Number',
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

  const tag = `cap-${randomUUID().slice(0, 8)}`;
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
    name: 'capped_offer',
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

  return {
    orgId: org.id,
    userId,
    auth: bearer(userId),
    accountId: account.id,
    wabaId,
    segmentId: segment.id,
    templateId: template.id,
    tag,
  };
}

let contactSerial = 0;
/** An opted-in, tagged contact with a NANP number no other fixture holds. */
async function contact(t: Tenant): Promise<{ contactId: string; phone: string }> {
  contactSerial += 1;
  const phone = `1555${String(2_000_000 + contactSerial * 13 + Math.floor(Math.random() * 12))}`;
  const contactId = await commerceInboxRepository.upsertContact({
    orgId: t.orgId,
    platform: 'whatsapp_cloud',
    externalId: phone,
    displayName: 'Capped Target',
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
  return { contactId, phone };
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

async function period(orgId: string): Promise<{ reserved: string; actual: string } | null> {
  const row = await db
    .selectFrom('commerce_spend_periods')
    .select(['reserved_micros', 'actual_micros'])
    .where('org_id', '=', orgId)
    .where('currency', '=', CUR)
    .executeTakeFirst();
  return row === undefined ? null : { reserved: row.reserved_micros, actual: row.actual_micros };
}

async function ledgerKinds(orgId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .selectFrom('commerce_spend_ledger')
    .select(['message_id', 'kind'])
    .where('org_id', '=', orgId)
    .execute();
  const byMessage = new Map<string, string[]>();
  for (const row of rows) {
    if (row.message_id === null) continue;
    byMessage.set(row.message_id, [...(byMessage.get(row.message_id) ?? []), row.kind]);
  }
  return byMessage;
}

beforeAll(async () => {
  // Other suites leave their own jobs behind, and the worker's claim is global by design.
  await db.deleteFrom('commerce_jobs').execute();

  const loaderId = await createUser(`spend-cap-loader-${randomUUID()}@stewra.invalid`);
  const card = await rateCardRepository.loadCard({
    currency: CUR,
    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    sourceNote: 'spend cap suite sheet',
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

beforeEach(() => {
  refuseNumbers = new Set();
  acceptedSends.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  for (const ref of createdSecrets) {
    await vault.delete(ref);
  }
  if (createdOrgs.length > 0) {
    await db.deleteFrom('commerce_jobs').where('org_id', 'in', createdOrgs).execute();
    // Trigger-enforced append-only; lifted only here in the harness for fixture cleanup.
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

describe('zero by default', () => {
  it('refuses to schedule a billable campaign for an org nobody granted headroom', async () => {
    const t = await tenant();
    await contact(t);

    const error = await schedule(t, 'No cap, no campaign').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as InstanceType<typeof ForbiddenError>).code).toBe('SPEND_CAP');

    // Not scheduled means not enqueued: nothing is waiting to march to a pause.
    const jobs = await db
      .selectFrom('commerce_jobs')
      .select('id')
      .where('org_id', '=', t.orgId)
      .execute();
    expect(jobs).toHaveLength(0);
  });

  it('an explicit zero cap is the same refusal, made on purpose', async () => {
    const t = await tenant();
    await contact(t);
    await spendCapRepository.setCap({
      orgId: t.orgId,
      currency: CUR,
      limitMicros: 0n,
      grantedByUserId: t.userId,
      note: 'deliberate lockout',
    });

    const error = await schedule(t, 'Zero is zero').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as InstanceType<typeof ForbiddenError>).code).toBe('SPEND_CAP');
  });
});

describe('the capped campaign', () => {
  it('sends until the money stops, pauses with no retry, and finishes cleanly once the cap is raised', async () => {
    const t = await tenant();
    const phones: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      phones.push((await contact(t)).phone);
    }
    // Headroom for one and a half batches: 37 sends of 25 = a full first batch of 25, twelve more
    // into the second, and a refusal at the thirty-eighth.
    await spendCapRepository.setCap({
      orgId: t.orgId,
      currency: CUR,
      limitMicros: 37n * RATE,
      grantedByUserId: t.userId,
      note: 'one and a half batches',
    });

    const broadcastId = await schedule(t, 'Runs out of money mid-campaign');
    await drainJobs(t.orgId);

    // The money stopped at exactly 37 — and so did the sends.
    expect(acceptedSends).toHaveLength(37);
    const paused = await broadcastService.get(t.orgId, broadcastId);
    expect(paused.status).toBe('paused');
    expect(paused.lastError).toContain('spend cap');

    // No send without a reservation: every accepted wamid's message holds a `reserve` ledger row.
    const kinds = await ledgerKinds(t.orgId);
    const reservedMessages = [...kinds.values()].filter((k) => k.includes('reserve'));
    expect(reservedMessages).toHaveLength(37);
    const sentMessages = await db
      .selectFrom('commerce_messages')
      .select(['id'])
      .where('org_id', '=', t.orgId)
      .where('status', '=', 'sent')
      .execute();
    expect(sentMessages).toHaveLength(37);
    for (const m of sentMessages) {
      expect(kinds.get(m.id)).toContain('reserve');
    }
    const p = await period(t.orgId);
    expect(p).toEqual({ reserved: (37n * RATE).toString(), actual: '0' });

    // Nobody half-claimed: the 23 not sent are all `pending`, ready for the resume; the message
    // row the refused reservation left behind is settled `failed` as evidence, not stranded.
    const ledger = await db
      .selectFrom('commerce_broadcast_recipients')
      .select(['status'])
      .where('broadcast_id', '=', broadcastId)
      .execute();
    expect(ledger.filter((r) => r.status === 'sent')).toHaveLength(37);
    expect(ledger.filter((r) => r.status === 'pending')).toHaveLength(23);
    expect(ledger.filter((r) => r.status === 'sending')).toHaveLength(0);

    // NO retry is waiting. A night ends on its own; a cap does not.
    const queued = await db
      .selectFrom('commerce_jobs')
      .select('id')
      .where('org_id', '=', t.orgId)
      .where('status', '=', 'queued')
      .execute();
    expect(queued).toHaveLength(0);

    // Resume without raising the cap is refused by name — the state does not change by waiting.
    const refused = await broadcastService.resume(t.orgId, broadcastId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((refused as InstanceType<typeof ForbiddenError>).code).toBe('SPEND_CAP');

    // The operator grants more; resume finishes the campaign without messaging anyone twice.
    await spendCapRepository.setCap({
      orgId: t.orgId,
      currency: CUR,
      limitMicros: 1_000_000n,
      grantedByUserId: t.userId,
      note: 'raised after the pause',
    });
    await broadcastService.resume(t.orgId, broadcastId);
    await drainJobs(t.orgId);

    const finished = await broadcastService.get(t.orgId, broadcastId);
    expect(finished.status).toBe('completed');
    expect(finished.sentCount).toBe(60);
    expect(acceptedSends).toHaveLength(60);
    const sentTo = acceptedSends.map((s) => s.to).sort();
    expect(new Set(sentTo).size).toBe(60);
    expect(sentTo).toEqual([...phones].sort());
  }, 30_000);

  it('two workers racing the last of the headroom cannot both pass the same money', async () => {
    const t = await tenant();
    await spendCapRepository.setCap({
      orgId: t.orgId,
      currency: CUR,
      limitMicros: 5n * RATE,
      grantedByUserId: t.userId,
      note: 'five messages of room',
    });
    // Ten real message rows racing for five messages of headroom, all at once.
    const { contactId } = await contact(t);
    const conversationId = await commerceInboxRepository.upsertConversation({
      orgId: t.orgId,
      channelAccountId: t.accountId,
      contactId,
      platform: 'whatsapp_cloud',
    });
    const messageIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const m = await commerceInboxRepository.recordOutbound({
        orgId: t.orgId,
        conversationId,
        platform: 'whatsapp_cloud',
        body: `race ${i}`,
        sentByUserId: t.userId,
      });
      messageIds.push(m.id);
    }
    const results = await Promise.all(
      messageIds.map((messageId) =>
        spendCapRepository.reserve({
          orgId: t.orgId,
          currency: CUR,
          amountMicros: RATE,
          messageId,
          broadcastId: null,
          at: new Date(),
        }),
      ),
    );
    expect(results.filter((r) => r === 'reserved')).toHaveLength(5);
    expect(results.filter((r) => r === 'insufficient')).toHaveLength(5);
    expect(await period(t.orgId)).toEqual({ reserved: (5n * RATE).toString(), actual: '0' });
  });

  it("releases a refused send's money and settles a delivered one at the receipt's real charge", async () => {
    const t = await tenant();
    const good = await contact(t);
    const bad = await contact(t);
    refuseNumbers = new Set([bad.phone]);
    await spendCapRepository.setCap({
      orgId: t.orgId,
      currency: CUR,
      limitMicros: 100n * RATE,
      grantedByUserId: t.userId,
      note: 'plenty',
    });

    const broadcastId = await schedule(t, 'One refused, one delivered');
    await drainJobs(t.orgId);
    expect((await broadcastService.get(t.orgId, broadcastId)).status).toBe('completed');
    expect(acceptedSends).toHaveLength(1);
    expect(acceptedSends[0]?.to).toBe(good.phone);

    // Meta's "no" was certain: that reservation is released, and only the delivered send holds.
    expect(await period(t.orgId)).toEqual({ reserved: RATE.toString(), actual: '0' });
    const kinds = await ledgerKinds(t.orgId);
    const closings = [...kinds.values()].map((k) => k.filter((x) => x !== 'reserve')).flat();
    expect(closings).toEqual(['release']);

    // The delivery receipt lands, the rater prices it, and the hold becomes an actual.
    const wamid = acceptedSends[0]?.wamid ?? '';
    const receipts = whatsappInboundAdapter.normalizeReceipts({
      id: t.wabaId,
      changes: [
        {
          field: 'messages',
          value: {
            statuses: [
              {
                id: wamid,
                status: 'delivered',
                pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' },
              },
            ],
          },
        },
      ],
    });
    await commerceInboundService.handleReceipt(receipts[0]!);

    expect(await period(t.orgId)).toEqual({ reserved: '0', actual: RATE.toString() });
    // A replayed webhook cannot credit the period twice.
    await commerceInboundService.handleReceipt(receipts[0]!);
    expect(await period(t.orgId)).toEqual({ reserved: '0', actual: RATE.toString() });
  });
});

describe('the two surfaces', () => {
  it('an org can read its usage; outsiders cannot; nobody org-side can write a cap', async () => {
    const t = await tenant();
    await spendCapRepository.setCap({
      orgId: t.orgId,
      currency: CUR,
      limitMicros: 50_000n,
      grantedByUserId: t.userId,
      note: 'readable',
    });

    const own = await request(app).get(`/orgs/${t.orgId}/spend`).set('Authorization', t.auth);
    expect(own.status).toBe(200);
    const usage = own.body.data.usage as Array<{ currency: string; limitMicros: string | null; headroomMicros: string }>;
    const entry = usage.find((u) => u.currency === CUR);
    expect(entry).toMatchObject({ limitMicros: '50000', headroomMicros: '50000' });

    // A member of a different org sees a tenancy refusal, not a neighbor's money.
    const outsider = await tenant();
    const cross = await request(app)
      .get(`/orgs/${t.orgId}/spend`)
      .set('Authorization', outsider.auth);
    expect([403, 404]).toContain(cross.status);

    // The org surface has no write; the platform surface refuses org users as if it did not exist.
    const write = await request(app)
      .put('/platform/spend-caps')
      .set('Authorization', t.auth)
      .send({ orgId: t.orgId, currency: CUR, limitMicros: '999999999', note: 'self-serve raise' });
    expect(write.status).toBe(404);
  });

  it('an install operator grants headroom over HTTP and reads back cap plus usage', async () => {
    const operatorId = await createUser(OPERATOR_EMAIL);
    const t = await tenant();

    const set = await request(app)
      .put('/platform/spend-caps')
      .set('Authorization', bearer(operatorId))
      .send({ orgId: t.orgId, currency: CUR, limitMicros: '123000', note: 'pilot agreement' });
    expect(set.status).toBe(200);
    expect(set.body.data.cap).toMatchObject({
      orgId: t.orgId,
      currency: CUR,
      limitMicros: '123000',
      note: 'pilot agreement',
    });

    const list = await request(app)
      .get('/platform/spend-caps')
      .query({ orgId: t.orgId })
      .set('Authorization', bearer(operatorId));
    expect(list.status).toBe(200);
    expect(list.body.data.caps).toHaveLength(1);
    const usage = list.body.data.usage as Array<{ currency: string; headroomMicros: string }>;
    expect(usage.find((u) => u.currency === CUR)?.headroomMicros).toBe('123000');

    // And the org can now schedule — the same predicate, seen from the happy side.
    await contact(t);
    const broadcastId = await schedule(t, 'Granted and go');
    await drainJobs(t.orgId);
    expect((await broadcastService.get(t.orgId, broadcastId)).status).toBe('completed');
  });
});
