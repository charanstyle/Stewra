import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';
import type { SegmentDefinition } from '@stewra/shared-types';

/**
 * BROADCASTS — the first feature that spends a client's money with nobody watching.
 *
 * The suite drives the real machinery end to end: a broadcast is scheduled through the service, the
 * real job queue claims its dispatch, the real send chain walks the ledger, and every message goes
 * over a real socket to a scripted Graph host. What gets pinned is the asymmetry the whole design
 * leans on — a person is easy to skip and impossible to un-message — and the money: Meta's delivery
 * receipt is the only place a cost ever comes from, and it must land against the campaign's message.
 */

const APP_ID = '100000000000001';
const APP_HMAC = randomBytes(32).toString('hex');

/** Recipient numbers Meta will refuse next, with a per-number error. */
let refuseNumbers: Set<string> = new Set();
/** Every send Meta accepted: the recipient and the wamid it was given. */
const acceptedSends: Array<{ to: string; wamid: string; template: string }> = [];

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
      const payload = JSON.parse(raw) as { to: string; template?: { name: string } };
      if (refuseNumbers.has(payload.to)) {
        json(res, 400, {
          error: { message: 'Recipient phone number not valid', code: 131026 },
        });
        return;
      }
      const wamid = `wamid.${randomUUID()}`;
      acceptedSends.push({ to: payload.to, wamid, template: payload.template?.name ?? '' });
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
const { ConflictError } = await import('../utils/errors.js');

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdOrgs: string[] = [];
const createdUsers: string[] = [];
const createdSecrets: string[] = [];

/** HH:MM in UTC, `offsetMinutes` from now — for quiet-hours windows placed relative to the test. */
function hhmmFromNow(offsetMinutes: number): string {
  const when = new Date(Date.now() + offsetMinutes * 60_000);
  return `${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}`;
}

interface Tenant {
  readonly orgId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly wabaId: string;
  readonly segmentId: string;
  readonly templateId: string;
  readonly tag: string;
}

/**
 * An org one call away from sending: active WhatsApp account, quiet hours parked away from now,
 * attestation signed, an approved two-variable template mirrored, and a tag-based segment.
 */
async function tenant(): Promise<Tenant> {
  const user = await db
    .insertInto('users')
    .values({
      email: `commerce-broadcasts-${randomUUID()}@stewra.invalid`,
      display_name: 'Broadcasts Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(user.id);

  const { org } = await organizationRepository.create({
    name: 'Broadcasts Test Org',
    slug: `bcast-${randomUUID().slice(0, 12)}`,
    createdBy: user.id,
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
    displayName: 'Broadcasts Test Number',
    displayPhoneNumber: null,
    credentialRef,
    credentialExpiresAt: null,
    meta: {},
  });

  // Quiet hours are mandatory before marketing may send; a one-minute window two hours away
  // satisfies the policy without ever covering the test's own clock.
  await consentService.setQuietHours({
    orgId: org.id,
    timezone: 'UTC',
    quietHoursStart: hhmmFromNow(120),
    quietHoursEnd: hhmmFromNow(121),
  });
  await consentService.attest({
    orgId: org.id,
    attestedByUserId: user.id,
    attestationText: 'We hold documented opt-in for every contact on this list.',
  });

  const tag = `campaign-${randomUUID().slice(0, 8)}`;
  const segment = await audienceService.createSegment({
    orgId: org.id,
    name: `Segment ${randomUUID().slice(0, 8)}`,
    description: null,
    definition: {
      match: 'all',
      rules: [{ type: 'tag', op: 'has', tag }],
    } satisfies SegmentDefinition,
    createdByUserId: user.id,
  });

  const template = await templateRepository.upsertFromMeta({
    orgId: org.id,
    channelAccountId: account.id,
    name: 'order_ready',
    language: 'en_US',
    category: 'marketing',
    providerCategory: 'MARKETING',
    status: 'approved',
    providerStatus: 'APPROVED',
    providerTemplateId: `tpl-${randomUUID().slice(0, 8)}`,
    headerText: null,
    bodyText: 'Hi {{1}}, your order from {{2}} is ready.',
    footerText: null,
    variableCount: 2,
    rejectionReason: null,
    qualityScore: null,
  });

  return {
    orgId: org.id,
    userId: user.id,
    accountId: account.id,
    wabaId,
    segmentId: segment.id,
    templateId: template.id,
    tag,
  };
}

/** A tagged contact with the given marketing consent state (or none at all). */
async function contact(
  t: Tenant,
  consent: 'opted_in' | 'opted_out' | 'none',
): Promise<{ contactId: string; phone: string }> {
  const phone = `1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
  const contactId = await commerceInboxRepository.upsertContact({
    orgId: t.orgId,
    platform: 'whatsapp_cloud',
    externalId: phone,
    displayName: 'Campaign Target',
    phoneE164: `+${phone}`,
  });
  const tagRow = await contactRepository.upsertTag(t.orgId, t.tag);
  await contactRepository.attachTag(t.orgId, contactId, tagRow.id);
  if (consent !== 'none') {
    await consentRepository.recordConsent({
      orgId: t.orgId,
      contactId,
      platform: 'whatsapp_cloud',
      purpose: 'marketing',
      state: consent,
      source: 'web_form',
      evidence: `https://example.invalid/form/${randomUUID()}`,
      recordedByUserId: t.userId,
    });
  }
  return { contactId, phone };
}

/**
 * Run the queue until this org has nothing left queued or running, defeating the backoff and the
 * quiet-hours retry delay the same way the jobs suite does: only `run_after` is ever touched.
 */
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
      .where(
        'id',
        'in',
        open.map((row) => row.id),
      )
      .execute();
    await commerceWorker.runOnce();
  }
  throw new Error(`org ${orgId} still has open jobs after ${maxPasses} passes`);
}

async function recipientsOf(
  broadcastId: string,
): Promise<Array<{ status: string; reason: string | null; provider_message_id: string | null }>> {
  return db
    .selectFrom('commerce_broadcast_recipients')
    .select(['status', 'reason', 'provider_message_id'])
    .where('broadcast_id', '=', broadcastId)
    .execute();
}

beforeAll(async () => {
  // Other suites leave their own jobs behind, and the worker's claim is global by design.
  await db.deleteFrom('commerce_jobs').execute();
});

beforeEach(() => {
  refuseNumbers = new Set();
  acceptedSends.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  for (const ref of createdSecrets) {
    await vault.delete(ref);
  }
  if (createdOrgs.length > 0) {
    await db.deleteFrom('commerce_jobs').where('org_id', 'in', createdOrgs).execute();
    await db
      .deleteFrom('commerce_broadcast_recipients')
      .where('org_id', 'in', createdOrgs)
      .execute();
    await db.deleteFrom('commerce_broadcasts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_messages').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_conversations').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_templates').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_segments').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_contact_tags').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_tags').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_messaging_policies').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_suppressions').where('org_id', 'in', createdOrgs).execute();
    // The consent log is trigger-enforced append-only; dropping test fixtures is the one legitimate
    // moment to lift that, and it is lifted here in the harness, not by weakening the trigger.
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_contact_consents DISABLE TRIGGER trg_commerce_consents_append_only`.execute(
        trx,
      );
      await trx
        .deleteFrom('commerce_contact_consents')
        .where('org_id', 'in', createdOrgs)
        .execute();
      await sql`ALTER TABLE commerce_contact_consents ENABLE TRIGGER trg_commerce_consents_append_only`.execute(
        trx,
      );
    });
    await db.deleteFrom('commerce_contacts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('channel_accounts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdUsers.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  await database.closeDb();
});

// ---------------------------------------------------------------------------------------------

describe('the whole campaign', () => {
  it('sends to the opted-in, skips the refused, and writes the ledger that explains both', async () => {
    const t = await tenant();
    const alice = await contact(t, 'opted_in');
    const bob = await contact(t, 'opted_in');
    const optedOut = await contact(t, 'opted_out');
    await contact(t, 'none');

    const broadcast = await broadcastService.create({
      orgId: t.orgId,
      createdByUserId: t.userId,
      name: 'Friday launch',
      channelAccountId: t.accountId,
      segmentId: t.segmentId,
      templateId: t.templateId,
      variables: ['there', 'Acme Coffee'],
      scheduledFor: new Date(Date.now() - 1000),
    });
    expect(broadcast.status).toBe('scheduled');

    await drainJobs(t.orgId);

    const finished = await broadcastService.get(t.orgId, broadcast.id);
    expect(finished.status).toBe('completed');
    expect(finished.totalRecipients).toBe(4);
    expect(finished.sentCount).toBe(2);
    // Two skips for two different refusals, both of which are the gate working, not a fault.
    expect(finished.skippedCount).toBe(2);
    expect(finished.failedCount).toBe(0);
    expect(finished.startedAt).not.toBeNull();
    expect(finished.completedAt).not.toBeNull();

    const sentTo = acceptedSends.map((send) => send.to).sort();
    expect(sentTo).toEqual([alice.phone, bob.phone].sort());
    expect(acceptedSends.every((send) => send.template === 'order_ready')).toBe(true);
    // The person who said no was decided locally — Meta never saw their number at all.
    expect(sentTo).not.toContain(optedOut.phone);

    const ledger = await recipientsOf(broadcast.id);
    const skipped = ledger.filter((row) => row.status === 'skipped');
    expect(skipped).toHaveLength(2);
    // The skip carries its reason: this is the evidence the consent gate ran, and what turns
    // "4 selected, 2 sent" from a discrepancy into an explanation.
    expect(skipped.every((row) => row.reason !== null && row.reason.length > 0)).toBe(true);

    // Every send produced a message row carrying the template — the hook cost attribution hangs on.
    const messages = await db
      .selectFrom('commerce_messages')
      .select(['status', 'template_id', 'provider_message_id', 'body'])
      .where('org_id', '=', t.orgId)
      .where('direction', '=', 'outbound')
      .execute();
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.status === 'sent' && m.template_id !== null)).toBe(true);
    // The stored body is the rendered text, not the template's raw source.
    expect(messages[0]?.body).toBe('Hi there, your order from Acme Coffee is ready.');
  });

  it('records a per-recipient refusal from Meta and still finishes everyone else', async () => {
    const t = await tenant();
    await contact(t, 'opted_in');
    const bad = await contact(t, 'opted_in');
    refuseNumbers = new Set([bad.phone]);

    const broadcast = await broadcastService.create({
      orgId: t.orgId,
      createdByUserId: t.userId,
      name: 'Partial failure',
      channelAccountId: t.accountId,
      segmentId: t.segmentId,
      templateId: t.templateId,
      variables: ['there', 'Acme'],
      scheduledFor: new Date(Date.now() - 1000),
    });
    await drainJobs(t.orgId);

    const finished = await broadcastService.get(t.orgId, broadcast.id);
    // Meta answering "no" for one number is certain and per-person: recorded on that recipient,
    // never allowed to stop the campaign.
    expect(finished.status).toBe('completed');
    expect(finished.sentCount).toBe(1);
    expect(finished.failedCount).toBe(1);

    const failed = (await recipientsOf(broadcast.id)).find((row) => row.status === 'failed');
    expect(failed?.reason).toContain('131026');
  });

  it('lands Meta\'s delivery pricing on the campaign message', async () => {
    const t = await tenant();
    await contact(t, 'opted_in');
    const broadcast = await broadcastService.create({
      orgId: t.orgId,
      createdByUserId: t.userId,
      name: 'Costed',
      channelAccountId: t.accountId,
      segmentId: t.segmentId,
      templateId: t.templateId,
      variables: ['there', 'Acme'],
      scheduledFor: new Date(Date.now() - 1000),
    });
    await drainJobs(t.orgId);

    // The delivery receipt arrives later, by webhook, keyed on nothing but the wamid the send
    // returned. This is the ONLY place a cost ever comes from.
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

    const summary = await commerceInboxRepository.costSummary({
      orgId: t.orgId,
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    expect(summary.billableByCategory.marketing).toBe(1);
    expect(summary.unpricedMessages).toBe(0);

    // And it joins back to the campaign: recipient → message → template → broadcast.
    const message = await db
      .selectFrom('commerce_messages')
      .select(['pricing_category', 'template_id', 'status'])
      .where('provider_message_id', '=', wamid)
      .executeTakeFirstOrThrow();
    expect(message.pricing_category).toBe('marketing');
    expect(message.template_id).toBe(t.templateId);
    expect(message.status).toBe('delivered');
    void broadcast;
  });
});

describe('steering a campaign', () => {
  it('cancelling a scheduled broadcast means its dispatch does nothing', async () => {
    const t = await tenant();
    await contact(t, 'opted_in');
    const broadcast = await broadcastService.create({
      orgId: t.orgId,
      createdByUserId: t.userId,
      name: 'Cancelled before it began',
      channelAccountId: t.accountId,
      segmentId: t.segmentId,
      templateId: t.templateId,
      variables: ['there', 'Acme'],
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
    });

    const cancelled = await broadcastService.cancel(t.orgId, broadcast.id);
    expect(cancelled.status).toBe('cancelled');

    // The dispatch job is still on the queue — cancellation does not dequeue, the job checks.
    await drainJobs(t.orgId);
    expect(acceptedSends).toHaveLength(0);
    expect(await recipientsOf(broadcast.id)).toHaveLength(0);
    expect((await broadcastService.get(t.orgId, broadcast.id)).status).toBe('cancelled');
  });

  it('pauses at quiet hours with nobody half-claimed, and a retry waiting', async () => {
    const t = await tenant();
    await contact(t, 'opted_in');
    await contact(t, 'opted_in');
    // Quiet hours now COVER the present moment — the gate must refuse the org, not the person.
    await consentService.setQuietHours({
      orgId: t.orgId,
      timezone: 'UTC',
      quietHoursStart: hhmmFromNow(-60),
      quietHoursEnd: hhmmFromNow(60),
    });

    const broadcast = await broadcastService.create({
      orgId: t.orgId,
      createdByUserId: t.userId,
      name: 'Scheduled into the night',
      channelAccountId: t.accountId,
      segmentId: t.segmentId,
      templateId: t.templateId,
      variables: ['there', 'Acme'],
      scheduledFor: new Date(Date.now() - 1000),
    });

    // One pass dispatches; the next runs the first send batch straight into quiet hours. `drainJobs`
    // is not used — it would chase the retry chain forever, which is precisely the behaviour under test.
    for (let pass = 0; pass < 3; pass += 1) {
      await db
        .updateTable('commerce_jobs')
        .set({ run_after: new Date(Date.now() - 1000) })
        .where('org_id', '=', t.orgId)
        .where('status', '=', 'queued')
        .execute();
      await commerceWorker.runOnce();
    }

    const paused = await broadcastService.get(t.orgId, broadcast.id);
    expect(paused.status).toBe('paused');
    expect(paused.lastError).toContain('quiet hours');
    expect(acceptedSends).toHaveLength(0);

    // Nobody stranded mid-claim: the whole batch went back to `pending`, because nothing was sent.
    const ledger = await recipientsOf(broadcast.id);
    expect(ledger.every((row) => row.status === 'pending')).toBe(true);

    // The chain parked itself in the future rather than dying — quiet hours end, and it wakes.
    const waiting = await db
      .selectFrom('commerce_jobs')
      .select(['run_after'])
      .where('org_id', '=', t.orgId)
      .where('kind', '=', 'broadcast_send')
      .where('status', '=', 'queued')
      .executeTakeFirst();
    expect(waiting).toBeDefined();
    expect(waiting!.run_after.getTime()).toBeGreaterThan(Date.now());
  });

  it('resume puts a paused broadcast straight back on the queue', async () => {
    const t = await tenant();
    await contact(t, 'opted_in');
    await consentService.setQuietHours({
      orgId: t.orgId,
      timezone: 'UTC',
      quietHoursStart: hhmmFromNow(-60),
      quietHoursEnd: hhmmFromNow(60),
    });
    const broadcast = await broadcastService.create({
      orgId: t.orgId,
      createdByUserId: t.userId,
      name: 'Paused then resumed',
      channelAccountId: t.accountId,
      segmentId: t.segmentId,
      templateId: t.templateId,
      variables: ['there', 'Acme'],
      scheduledFor: new Date(Date.now() - 1000),
    });
    for (let pass = 0; pass < 3; pass += 1) {
      await db
        .updateTable('commerce_jobs')
        .set({ run_after: new Date(Date.now() - 1000) })
        .where('org_id', '=', t.orgId)
        .where('status', '=', 'queued')
        .execute();
      await commerceWorker.runOnce();
    }
    expect((await broadcastService.get(t.orgId, broadcast.id)).status).toBe('paused');

    // Quiet hours end (the operator moves them; the clock moving works the same way)…
    await consentService.setQuietHours({
      orgId: t.orgId,
      timezone: 'UTC',
      quietHoursStart: hhmmFromNow(120),
      quietHoursEnd: hhmmFromNow(121),
    });
    await broadcastService.resume(t.orgId, broadcast.id);
    await drainJobs(t.orgId);

    const finished = await broadcastService.get(t.orgId, broadcast.id);
    expect(finished.status).toBe('completed');
    expect(finished.sentCount).toBe(1);
  });

  it('refuses to delete the segment or template a live campaign points at, by name', async () => {
    const t = await tenant();
    await contact(t, 'opted_in');
    await broadcastService.create({
      orgId: t.orgId,
      createdByUserId: t.userId,
      name: 'Holding its references',
      channelAccountId: t.accountId,
      segmentId: t.segmentId,
      templateId: t.templateId,
      variables: ['there', 'Acme'],
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
    });

    // Both refusals carry the campaign's name — a constraint violation would carry a constraint's.
    await expect(audienceService.deleteSegment(t.orgId, t.segmentId)).rejects.toThrow(
      /Holding its references/,
    );
    await expect(audienceService.deleteSegment(t.orgId, t.segmentId)).rejects.toThrow(
      ConflictError,
    );
  });
});

describe('the forecast', () => {
  it('counts what will send, under which category, per country — and names no price', async () => {
    const t = await tenant();
    await contact(t, 'opted_in');
    await contact(t, 'opted_in');
    await contact(t, 'opted_out');

    const { audience, forecast } = await broadcastService.preview({
      orgId: t.orgId,
      segmentId: t.segmentId,
      templateId: t.templateId,
    });

    expect(audience.total).toBe(3);
    expect(audience.sendable).toBe(2);
    expect(forecast.billableMessages).toBe(2);
    expect(forecast.category).toBe('marketing');
    // All fixture numbers are +1555…, so the whole sendable audience sits under NANP.
    expect(forecast.byCountryCode).toEqual({ '1': 2 });
    // The one thing deliberately absent: a currency amount. Meta publishes rates as a spreadsheet,
    // and an invented number multiplied by a real audience is a figure a client would plan against.
    expect(Object.keys(forecast)).not.toContain('estimatedCost');
  });
});
