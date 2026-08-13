import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';

/**
 * SINGLE-CONTACT TEMPLATE SEND — the inbox's business-initiated half.
 *
 * The dead-end this closes: outside the 24-hour window `sendReply` refuses and says "only an
 * approved template message can be delivered now", and until this path existed nothing could send
 * one. What the suite pins is the permission model: the template's CATEGORY chooses the consent
 * purpose, so a marketing template one-at-a-time faces exactly the gate a broadcast does, while a
 * utility template needs only what an ordinary reply needs.
 */

const APP_ID = '100000000000031';
const APP_HMAC = randomBytes(32).toString('hex');

/** Recipient numbers Meta will refuse next, with a per-number error. */
let refuseNumbers: Set<string> = new Set();
/** Every send Meta accepted: the recipient and the template it was for. */
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
process.env['META_COMMERCE_CONFIG_ID'] = '200000000000032';
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
const { consentRepository } = await import('../commerce/repositories/consentRepository.js');
const { commerceInboxService } = await import('../commerce/services/commerceInboxService.js');
const { consentService } = await import('../commerce/services/consentService.js');
const { WhatsappSendRefusedError } = await import(
  '../commerce/services/senders/whatsappCloudSender.js'
);
const { vault } = await import('../control-plane/vault/vault.js');
const { NotFoundError, ValidationError } = await import('../utils/errors.js');

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
  readonly marketingTemplateId: string;
  readonly utilityTemplateId: string;
  readonly uncategorizedTemplateId: string;
  readonly pendingTemplateId: string;
}

async function mirrorTemplate(params: {
  orgId: string;
  channelAccountId: string;
  name: string;
  category: 'marketing' | 'utility' | null;
  providerCategory: string;
  status?: 'approved' | 'pending';
  bodyText?: string;
  variableCount?: number;
}): Promise<string> {
  const template = await templateRepository.upsertFromMeta({
    orgId: params.orgId,
    channelAccountId: params.channelAccountId,
    name: params.name,
    language: 'en_US',
    category: params.category,
    providerCategory: params.providerCategory,
    status: params.status ?? 'approved',
    providerStatus: (params.status ?? 'approved').toUpperCase(),
    providerTemplateId: `tpl-${randomUUID().slice(0, 8)}`,
    headerText: null,
    bodyText: params.bodyText ?? 'Hi {{1}}, your order from {{2}} is ready.',
    footerText: null,
    variableCount: params.variableCount ?? 2,
    rejectionReason: null,
    qualityScore: null,
  });
  return template.id;
}

/**
 * An org one call away from sending: active WhatsApp account, quiet hours parked away from now,
 * attestation signed, and one approved template of each category worth distinguishing.
 */
async function tenant(): Promise<Tenant> {
  const user = await db
    .insertInto('users')
    .values({
      email: `commerce-inbox-template-${randomUUID()}@stewra.invalid`,
      display_name: 'Inbox Template Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(user.id);

  const { org } = await organizationRepository.create({
    name: 'Inbox Template Test Org',
    slug: `inboxtpl-${randomUUID().slice(0, 12)}`,
    createdBy: user.id,
  });
  createdOrgs.push(org.id);

  const credentialRef = await vault.put(`test-token-${randomUUID()}`);
  createdSecrets.push(credentialRef);
  const { account } = await channelAccountRepository.upsert({
    orgId: org.id,
    platform: 'whatsapp_cloud',
    externalAccountId: `waba-${randomUUID().slice(0, 12)}`,
    phoneNumberId: `pn-${randomUUID().slice(0, 12)}`,
    displayName: 'Inbox Template Test Number',
    displayPhoneNumber: null,
    credentialRef,
    credentialExpiresAt: null,
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
    attestedByUserId: user.id,
    attestationText: 'We hold documented opt-in for every contact on this list.',
  });

  const marketingTemplateId = await mirrorTemplate({
    orgId: org.id,
    channelAccountId: account.id,
    name: 'spring_offer',
    category: 'marketing',
    providerCategory: 'MARKETING',
  });
  const utilityTemplateId = await mirrorTemplate({
    orgId: org.id,
    channelAccountId: account.id,
    name: 'order_update',
    category: 'utility',
    providerCategory: 'UTILITY',
  });
  // Meta reported a category this build does not model — mirrored as null, never guessed at.
  const uncategorizedTemplateId = await mirrorTemplate({
    orgId: org.id,
    channelAccountId: account.id,
    name: 'mystery_category',
    category: null,
    providerCategory: 'SOMETHING_NEW',
  });
  const pendingTemplateId = await mirrorTemplate({
    orgId: org.id,
    channelAccountId: account.id,
    name: 'still_in_review',
    category: 'utility',
    providerCategory: 'UTILITY',
    status: 'pending',
  });

  return {
    orgId: org.id,
    userId: user.id,
    accountId: account.id,
    marketingTemplateId,
    utilityTemplateId,
    uncategorizedTemplateId,
    pendingTemplateId,
  };
}

/**
 * A contact with a conversation whose 24-hour window never opened — the exact state `sendReply`
 * refuses, and the state this whole path exists for.
 */
async function conversation(
  t: Tenant,
  consent: 'opted_in' | 'opted_out' | 'none',
): Promise<{ contactId: string; conversationId: string; phone: string }> {
  const phone = `1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
  const contactId = await commerceInboxRepository.upsertContact({
    orgId: t.orgId,
    platform: 'whatsapp_cloud',
    externalId: phone,
    displayName: 'Template Recipient',
    phoneE164: `+${phone}`,
  });
  const conversationId = await commerceInboxRepository.upsertConversation({
    orgId: t.orgId,
    channelAccountId: t.accountId,
    contactId,
    platform: 'whatsapp_cloud',
  });
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
  return { contactId, conversationId, phone };
}

async function messageRows(
  conversationId: string,
): Promise<Array<{ body: string; status: string; template_id: string | null; failure_reason: string | null }>> {
  return db
    .selectFrom('commerce_messages')
    .select(['body', 'status', 'template_id', 'failure_reason'])
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'asc')
    .execute();
}

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
    await db.deleteFrom('commerce_messages').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_conversations').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_templates').where('org_id', 'in', createdOrgs).execute();
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

describe('sending a template into a conversation', () => {
  it('delivers a marketing template to an opted-in contact with the window closed', async () => {
    const t = await tenant();
    const { conversationId, phone } = await conversation(t, 'opted_in');

    const message = await commerceInboxService.sendTemplate({
      orgId: t.orgId,
      conversationId,
      templateId: t.marketingTemplateId,
      variables: ['Ada', 'Stewra'],
      sentByUserId: t.userId,
    });

    expect(message.status).toBe('sent');
    expect(message.templateId).toBe(t.marketingTemplateId);
    // The thread shows the substituted text, not the template's raw source.
    expect(message.body).toBe('Hi Ada, your order from Stewra is ready.');
    expect(acceptedSends).toHaveLength(1);
    expect(acceptedSends[0]?.to).toBe(phone);
    expect(acceptedSends[0]?.template).toBe('spring_offer');
  });

  it('refuses a marketing template when no marketing consent is on file — and sends nothing', async () => {
    const t = await tenant();
    const { conversationId } = await conversation(t, 'none');

    await expect(
      commerceInboxService.sendTemplate({
        orgId: t.orgId,
        conversationId,
        templateId: t.marketingTemplateId,
        variables: ['Ada', 'Stewra'],
        sentByUserId: t.userId,
      }),
    ).rejects.toMatchObject({ code: 'NO_MARKETING_CONSENT' });

    // The gate ran before the message row was written: no evidence of an attempt, because there
    // was no attempt.
    expect(await messageRows(conversationId)).toHaveLength(0);
    expect(acceptedSends).toHaveLength(0);
  });

  it('refuses a marketing template to a contact who opted out', async () => {
    const t = await tenant();
    const { conversationId } = await conversation(t, 'opted_out');

    await expect(
      commerceInboxService.sendTemplate({
        orgId: t.orgId,
        conversationId,
        templateId: t.marketingTemplateId,
        variables: ['Ada', 'Stewra'],
        sentByUserId: t.userId,
      }),
    ).rejects.toMatchObject({ code: 'MARKETING_OPTED_OUT' });
    expect(acceptedSends).toHaveLength(0);
  });

  it('delivers a utility template with no marketing consent at all — transactional is service', async () => {
    const t = await tenant();
    const { conversationId } = await conversation(t, 'none');

    const message = await commerceInboxService.sendTemplate({
      orgId: t.orgId,
      conversationId,
      templateId: t.utilityTemplateId,
      variables: ['Ada', 'Stewra'],
      sentByUserId: t.userId,
    });

    expect(message.status).toBe('sent');
    expect(acceptedSends).toHaveLength(1);
  });

  it('refuses even a utility template to a suppressed contact', async () => {
    const t = await tenant();
    const { conversationId, phone } = await conversation(t, 'opted_in');
    await consentService.suppress({
      orgId: t.orgId,
      platform: 'whatsapp_cloud',
      externalId: phone,
      reason: 'complaint',
      detail: 'Escalated to the platform',
    });

    await expect(
      commerceInboxService.sendTemplate({
        orgId: t.orgId,
        conversationId,
        templateId: t.utilityTemplateId,
        variables: ['Ada', 'Stewra'],
        sentByUserId: t.userId,
      }),
    ).rejects.toMatchObject({ code: 'CONTACT_SUPPRESSED' });
    expect(acceptedSends).toHaveLength(0);
  });

  it('gates a template of unrecognized category as marketing — the strict reading', async () => {
    const t = await tenant();
    const { conversationId } = await conversation(t, 'none');

    await expect(
      commerceInboxService.sendTemplate({
        orgId: t.orgId,
        conversationId,
        templateId: t.uncategorizedTemplateId,
        variables: ['Ada', 'Stewra'],
        sentByUserId: t.userId,
      }),
    ).rejects.toMatchObject({ code: 'NO_MARKETING_CONSENT' });
  });

  it('refuses a marketing template during quiet hours, exactly as a broadcast would be', async () => {
    const t = await tenant();
    // Re-park quiet hours over the test's own clock.
    await consentService.setQuietHours({
      orgId: t.orgId,
      timezone: 'UTC',
      quietHoursStart: hhmmFromNow(-30),
      quietHoursEnd: hhmmFromNow(30),
    });
    const { conversationId } = await conversation(t, 'opted_in');

    await expect(
      commerceInboxService.sendTemplate({
        orgId: t.orgId,
        conversationId,
        templateId: t.marketingTemplateId,
        variables: ['Ada', 'Stewra'],
        sentByUserId: t.userId,
      }),
    ).rejects.toMatchObject({ code: 'QUIET_HOURS' });
    expect(acceptedSends).toHaveLength(0);
  });

  it('quiet hours do not block a utility template — it is a reply in permission terms', async () => {
    const t = await tenant();
    await consentService.setQuietHours({
      orgId: t.orgId,
      timezone: 'UTC',
      quietHoursStart: hhmmFromNow(-30),
      quietHoursEnd: hhmmFromNow(30),
    });
    const { conversationId } = await conversation(t, 'none');

    const message = await commerceInboxService.sendTemplate({
      orgId: t.orgId,
      conversationId,
      templateId: t.utilityTemplateId,
      variables: ['Ada', 'Stewra'],
      sentByUserId: t.userId,
    });
    expect(message.status).toBe('sent');
  });

  it('refuses a template that is not approved', async () => {
    const t = await tenant();
    const { conversationId } = await conversation(t, 'opted_in');

    await expect(
      commerceInboxService.sendTemplate({
        orgId: t.orgId,
        conversationId,
        templateId: t.pendingTemplateId,
        variables: ['Ada', 'Stewra'],
        sentByUserId: t.userId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a variable count that does not match the template', async () => {
    const t = await tenant();
    const { conversationId } = await conversation(t, 'opted_in');

    await expect(
      commerceInboxService.sendTemplate({
        orgId: t.orgId,
        conversationId,
        templateId: t.marketingTemplateId,
        variables: ['Ada'],
        sentByUserId: t.userId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a template that belongs to a different WhatsApp number', async () => {
    const t = await tenant();
    const { conversationId } = await conversation(t, 'opted_in');

    // A second number on the SAME org, with its own approved template.
    const credentialRef = await vault.put(`test-token-${randomUUID()}`);
    createdSecrets.push(credentialRef);
    const { account: other } = await channelAccountRepository.upsert({
      orgId: t.orgId,
      platform: 'whatsapp_cloud',
      externalAccountId: `waba-${randomUUID().slice(0, 12)}`,
      phoneNumberId: `pn-${randomUUID().slice(0, 12)}`,
      displayName: 'Second Number',
      displayPhoneNumber: null,
      credentialRef,
      credentialExpiresAt: null,
      meta: {},
    });
    const otherTemplateId = await mirrorTemplate({
      orgId: t.orgId,
      channelAccountId: other.id,
      name: 'wrong_number_template',
      category: 'utility',
      providerCategory: 'UTILITY',
    });

    await expect(
      commerceInboxService.sendTemplate({
        orgId: t.orgId,
        conversationId,
        templateId: otherTemplateId,
        variables: ['Ada', 'Stewra'],
        sentByUserId: t.userId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(acceptedSends).toHaveLength(0);
  });

  it("cannot send another organization's template — the lookup is tenant-scoped", async () => {
    const a = await tenant();
    const b = await tenant();
    const { conversationId } = await conversation(a, 'opted_in');

    await expect(
      commerceInboxService.sendTemplate({
        orgId: a.orgId,
        conversationId,
        templateId: b.utilityTemplateId,
        variables: ['Ada', 'Stewra'],
        sentByUserId: a.userId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cannot reach another organization's conversation", async () => {
    const a = await tenant();
    const b = await tenant();
    const { conversationId } = await conversation(a, 'opted_in');

    await expect(
      commerceInboxService.sendTemplate({
        orgId: b.orgId,
        conversationId,
        templateId: b.utilityTemplateId,
        variables: ['Ada', 'Stewra'],
        sentByUserId: b.userId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('settles the message row as failed, with the reason, when Meta refuses the send', async () => {
    const t = await tenant();
    const { conversationId, phone } = await conversation(t, 'opted_in');
    refuseNumbers = new Set([phone]);

    await expect(
      commerceInboxService.sendTemplate({
        orgId: t.orgId,
        conversationId,
        templateId: t.marketingTemplateId,
        variables: ['Ada', 'Stewra'],
        sentByUserId: t.userId,
      }),
    ).rejects.toBeInstanceOf(WhatsappSendRefusedError);

    // The attempt left evidence: a failed row with the platform's own reason on it.
    const rows = await messageRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.template_id).toBe(t.marketingTemplateId);
    expect(rows[0]?.failure_reason).toContain('not valid');
  });
});
