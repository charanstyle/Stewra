import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';

/**
 * THE TEMPLATE MIRROR.
 *
 * A template is Meta's object; this build holds a copy. Everything asserted here is some form of one
 * question: can the copy ever claim more than Meta actually said? A mirror that drifts optimistic
 * fails one recipient at a time, mid-campaign — so the suite pins the pessimistic behaviours:
 * unrecognized statuses land on `unknown` (which cannot send), unrecognized categories land on null
 * (which cannot price), a webhook writes only what it carried, and a template Meta stopped listing
 * stops being sendable.
 *
 * Meta is a real HTTP server, per this repo's rule: `META_COMMERCE_GRAPH_BASE_URL` points at it and
 * the service makes real fetch calls over a real socket. Its list endpoint serves whatever
 * `remoteTemplates` holds, so each test scripts Meta's answer, not our client.
 */

const APP_ID = '100000000000001';
const APP_HMAC = randomBytes(32).toString('hex');

/** What Meta's list endpoint returns next. */
let remoteTemplates: unknown[] = [];
/** What Meta's create endpoint returns next — scripted per test to exercise re-categorization. */
let createReply: Record<string, string> = {};
/** Every create payload Meta received, so component shapes are assertable. */
const createBodies: unknown[] = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const graph: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname.replace(/^\/v\d+\.\d+\//, '');

  if (pathname.endsWith('/message_templates') && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      createBodies.push(JSON.parse(raw));
      json(res, 200, { id: `tpl-${randomUUID().slice(0, 8)}`, status: 'PENDING', ...createReply });
    });
    return;
  }
  if (pathname.endsWith('/message_templates') && req.method === 'GET') {
    json(res, 200, { data: remoteTemplates });
    return;
  }
  if (pathname.endsWith('/message_templates') && req.method === 'DELETE') {
    json(res, 200, { success: true });
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
const { templateService } = await import('../commerce/services/templateService.js');
const { commerceInboundService } = await import(
  '../commerce/services/commerceInboundService.js'
);
const { whatsappInboundAdapter } = await import(
  '../commerce/services/inbound/whatsappAdapter.js'
);
const {
  assertHeaderAndFooter,
  assertTemplateName,
  countTemplateVariables,
  mapTemplateCategory,
  mapTemplateStatus,
} = await import('../commerce/services/templateBody.js');
const { vault } = await import('../control-plane/vault/vault.js');
const { ValidationError, ConflictError } = await import('../utils/errors.js');

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdOrgs: string[] = [];
const createdUsers: string[] = [];
const createdSecrets: string[] = [];

interface Tenant {
  readonly orgId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly wabaId: string;
}

async function tenant(): Promise<Tenant> {
  const user = await db
    .insertInto('users')
    .values({
      email: `commerce-templates-${randomUUID()}@stewra.invalid`,
      display_name: 'Templates Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(user.id);

  const { org } = await organizationRepository.create({
    name: 'Templates Test Org',
    slug: `tpl-${randomUUID().slice(0, 12)}`,
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
    displayName: 'Templates Test Number',
    displayPhoneNumber: null,
    credentialRef,
    credentialExpiresAt: null,
    billingCurrency: 'USD',
    meta: {},
  });
  return { orgId: org.id, userId: user.id, accountId: account.id, wabaId };
}

/** One remote template in Meta's list shape. */
function remote(params: {
  name: string;
  language?: string;
  status?: string;
  category?: string;
  body?: string;
}): unknown {
  return {
    id: `tpl-${randomUUID().slice(0, 8)}`,
    name: params.name,
    language: params.language ?? 'en_US',
    status: params.status ?? 'APPROVED',
    category: params.category ?? 'MARKETING',
    components: [{ type: 'BODY', text: params.body ?? 'Hello there, welcome aboard.' }],
  };
}

/** A Meta webhook entry carrying one template event. */
function templateEventEntry(
  wabaId: string,
  field: string,
  value: Record<string, string>,
): unknown {
  return { id: wabaId, changes: [{ field, value }] };
}

/** A Meta webhook entry carrying one delivery receipt. */
function receiptEntry(wabaId: string, status: Record<string, unknown>): unknown {
  return { id: wabaId, changes: [{ field: 'messages', value: { statuses: [status] } }] };
}

beforeEach(() => {
  remoteTemplates = [];
  createReply = {};
  createBodies.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  for (const ref of createdSecrets) {
    await vault.delete(ref);
  }
  if (createdOrgs.length > 0) {
    await db.deleteFrom('commerce_messages').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_conversations').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_contacts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_templates').where('org_id', 'in', createdOrgs).execute();
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

describe('body rules', () => {
  it('counts positional placeholders', () => {
    expect(countTemplateVariables('No variables at all.')).toBe(0);
    expect(countTemplateVariables('Hi {{1}}, your {{2}} is ready.')).toBe(2);
  });

  it.each([
    ['a gap in the numbering', 'Hi {{1}}, your {{3}} is ready.'],
    ['a repeated number', 'Hi {{1}}, your {{1}} is ready.'],
    ['starting with a placeholder', '{{1}} is ready for pickup.'],
    ['ending with a placeholder', 'Ready for pickup: {{1}}'],
    ['adjacent placeholders', 'Hi {{1}} {{2}}, welcome.'],
  ])('refuses %s before it reaches Meta', (_label, body) => {
    // Meta enforces every one of these at submission — per recipient if it slips to send time. The
    // local check exists so the client reads which placeholder is wrong instead of a Graph code.
    expect(() => countTemplateVariables(body)).toThrow(ValidationError);
  });

  it('refuses a name Meta would refuse', () => {
    expect(() => assertTemplateName('Order Update!')).toThrow(ValidationError);
    expect(() => assertTemplateName('order_update_2')).not.toThrow();
  });

  it('refuses a header placeholder, and still sees the next header correctly', () => {
    expect(() => assertHeaderAndFooter('Hello {{1}}', null)).toThrow(ValidationError);
    // The placeholder regex is global; without the lastIndex reset the second call would resume
    // mid-string and pass a header it should fail — or fail one it should pass.
    expect(() => assertHeaderAndFooter('Hello {{1}}', null)).toThrow(ValidationError);
    expect(() => assertHeaderAndFooter('Plain header', null)).not.toThrow();
  });
});

describe('vocabulary mapping', () => {
  it('maps the statuses Meta documents and refuses to guess the rest', () => {
    expect(mapTemplateStatus('APPROVED')).toBe('approved');
    expect(mapTemplateStatus('IN_APPEAL')).toBe('pending');
    expect(mapTemplateStatus('PENDING_DELETION')).toBe('disabled');
    // A status this build has never met is one nobody decided is safe to send. `unknown` is a
    // refusal, and the nearest-neighbour guess it replaces is how a flagged template keeps going out.
    expect(mapTemplateStatus('LIMIT_EXCEEDED')).toBe('unknown');
  });

  it('maps known categories and returns null — not a stand-in — for the rest', () => {
    expect(mapTemplateCategory('MARKETING')).toBe('marketing');
    expect(mapTemplateCategory('utility')).toBe('utility');
    // Unlike a status, a category is a rate. An invented one becomes a number on an invoice, so the
    // honest answer is "no category", with Meta's word kept verbatim alongside.
    expect(mapTemplateCategory('CAROUSEL_PROMO')).toBeNull();
  });
});

describe('creating a template', () => {
  it('submits the components and mirrors what Meta answered, not what was asked', async () => {
    const t = await tenant();
    // Meta re-files templates it reads as marketing regardless of the request — and the category
    // decides the price, so the mirror must record Meta's answer.
    createReply = { category: 'MARKETING' };

    const template = await templateService.create(t.orgId, t.userId, {
      channelAccountId: t.accountId,
      name: 'order_ready',
      language: 'en_US',
      category: 'utility',
      headerText: 'Order update',
      bodyText: 'Hi {{1}}, your order {{2}} is ready.',
      footerText: 'Reply STOP to opt out',
    });

    expect(template.status).toBe('pending');
    expect(template.category).toBe('marketing');
    expect(template.providerCategory).toBe('MARKETING');
    expect(template.variableCount).toBe(2);

    const sent = createBodies[0] as {
      category: string;
      components: Array<{ type: string; text?: string; example?: { body_text: string[][] } }>;
    };
    expect(sent.category).toBe('UTILITY');
    expect(sent.components.map((c) => c.type)).toEqual(['HEADER', 'BODY', 'FOOTER']);
    // A body with placeholders and no example values is refused by Meta outright.
    expect(sent.components[1]?.example?.body_text[0]).toHaveLength(2);
  });

  it('refuses a duplicate name and language on the same account', async () => {
    const t = await tenant();
    const request = {
      channelAccountId: t.accountId,
      name: 'welcome_note',
      language: 'en_US',
      category: 'utility' as const,
      headerText: null,
      bodyText: 'Welcome aboard.',
      footerText: null,
    };
    await templateService.create(t.orgId, t.userId, request);
    await expect(templateService.create(t.orgId, t.userId, request)).rejects.toThrow(
      ConflictError,
    );
  });
});

describe('syncing the mirror', () => {
  it('adopts a template created in WhatsApp Manager, deriving its variable count', async () => {
    const t = await tenant();
    remoteTemplates = [
      remote({ name: 'made_in_manager', body: 'Hi {{1}}, your {{2}} ships {{3}}.' }),
    ];

    const account = await channelAccountRepository.findForOrg(t.orgId, t.accountId);
    const result = await templateService.syncAccount(account!);

    expect(result.synced).toBe(1);
    const stored = (await templateRepository.listForOrg(t.orgId))[0];
    expect(stored?.status).toBe('approved');
    // Derived from what Meta holds, never declared: a broadcast checked against this count is what
    // stands between a client and per-recipient rejections mid-campaign.
    expect(stored?.variableCount).toBe(3);
    expect(stored?.lastSyncedAt).not.toBeNull();
  });

  it('stops trusting a template Meta no longer lists', async () => {
    const t = await tenant();
    remoteTemplates = [remote({ name: 'keeper' }), remote({ name: 'goner' })];
    const account = await channelAccountRepository.findForOrg(t.orgId, t.accountId);
    await templateService.syncAccount(account!);

    remoteTemplates = [remote({ name: 'keeper' })];
    const second = await templateService.syncAccount(account!);

    const templates = await templateRepository.listForOrg(t.orgId);
    const goner = templates.find((tpl) => tpl.name === 'goner');
    // `unknown`, not deleted: the row is the evidence the template existed, and `unknown` is not
    // `approved`, which is all the send gate needs.
    expect(goner?.status).toBe('unknown');
    expect(goner?.providerStatus).toBe('MISSING_AT_META');
    expect(second.changed.map((tpl) => tpl.name)).toContain('goner');
  });

  it('records a category it cannot map as null with Meta\'s word preserved', async () => {
    const t = await tenant();
    remoteTemplates = [remote({ name: 'novel_category', category: 'SOMETHING_NEW' })];
    const account = await channelAccountRepository.findForOrg(t.orgId, t.accountId);
    await templateService.syncAccount(account!);

    const stored = (await templateRepository.listForOrg(t.orgId))[0];
    expect(stored?.category).toBeNull();
    expect(stored?.providerCategory).toBe('SOMETHING_NEW');
  });
});

describe('the template webhooks', () => {
  it('applies a status event without touching the category', async () => {
    const t = await tenant();
    remoteTemplates = [remote({ name: 'flagged', category: 'MARKETING' })];
    const account = await channelAccountRepository.findForOrg(t.orgId, t.accountId);
    await templateService.syncAccount(account!);

    const events = whatsappInboundAdapter.normalizeTemplateEvents(
      templateEventEntry(t.wabaId, 'message_template_status_update', {
        event: 'PAUSED',
        message_template_name: 'flagged',
        message_template_language: 'en_US',
        reason: 'Recipients reported this template',
      }),
    );
    expect(events).toHaveLength(1);
    await commerceInboundService.handleTemplateEvent(events[0]!);

    const stored = (await templateRepository.listForOrg(t.orgId))[0];
    expect(stored?.status).toBe('paused');
    expect(stored?.rejectionReason).toBe('Recipients reported this template');
    // The event carried no category, so the category it had stays exactly as it was.
    expect(stored?.category).toBe('marketing');
  });

  it('applies a category event without inventing a status', async () => {
    const t = await tenant();
    remoteTemplates = [remote({ name: 'refiled', category: 'UTILITY' })];
    const account = await channelAccountRepository.findForOrg(t.orgId, t.accountId);
    await templateService.syncAccount(account!);

    const events = whatsappInboundAdapter.normalizeTemplateEvents(
      templateEventEntry(t.wabaId, 'message_template_category_update', {
        message_template_name: 'refiled',
        message_template_language: 'en_US',
        new_category: 'MARKETING',
      }),
    );
    await commerceInboundService.handleTemplateEvent(events[0]!);

    const stored = (await templateRepository.listForOrg(t.orgId))[0];
    expect(stored?.category).toBe('marketing');
    // Writing a placeholder status here is how a re-categorization silently un-approves a template
    // and stops every campaign using it. The approval must survive the re-filing.
    expect(stored?.status).toBe('approved');
  });

  it('records a re-filing onto a category this build cannot name', async () => {
    const t = await tenant();
    remoteTemplates = [remote({ name: 'refiled_novel', category: 'UTILITY' })];
    const account = await channelAccountRepository.findForOrg(t.orgId, t.accountId);
    await templateService.syncAccount(account!);

    const events = whatsappInboundAdapter.normalizeTemplateEvents(
      templateEventEntry(t.wabaId, 'message_template_category_update', {
        message_template_name: 'refiled_novel',
        message_template_language: 'en_US',
        new_category: 'FUTURE_TIER',
      }),
    );
    await commerceInboundService.handleTemplateEvent(events[0]!);

    const stored = (await templateRepository.listForOrg(t.orgId))[0];
    // The re-filing is recorded — null category, verbatim word — rather than dropped with it.
    expect(stored?.category).toBeNull();
    expect(stored?.providerCategory).toBe('FUTURE_TIER');
  });
});

describe('the send gate', () => {
  it('refuses anything not currently approved, and a variable count that does not match', async () => {
    const t = await tenant();
    remoteTemplates = [
      remote({ name: 'pending_one', status: 'PENDING' }),
      remote({ name: 'live_one', body: 'Hi {{1}}, welcome.' }),
    ];
    const account = await channelAccountRepository.findForOrg(t.orgId, t.accountId);
    await templateService.syncAccount(account!);
    const templates = await templateRepository.listForOrg(t.orgId);
    const pending = templates.find((tpl) => tpl.name === 'pending_one');
    const live = templates.find((tpl) => tpl.name === 'live_one');

    await expect(templateService.assertSendable(t.orgId, pending?.id ?? '', 0)).rejects.toThrow(
      ValidationError,
    );
    await expect(templateService.assertSendable(t.orgId, live?.id ?? '', 2)).rejects.toThrow(
      ValidationError,
    );
    await expect(
      templateService.assertSendable(t.orgId, live?.id ?? '', 1),
    ).resolves.toMatchObject({ name: 'live_one' });
  });
});

// ---------------------------------------------------------------------------------------------

describe('delivery receipts', () => {
  /** An outbound message with a provider id, ready to receive receipts. */
  async function sentMessage(t: Tenant): Promise<{ messageId: string; wamid: string }> {
    const contactId = await commerceInboxRepository.upsertContact({
      orgId: t.orgId,
      platform: 'whatsapp_cloud',
      externalId: `1555${Math.floor(Math.random() * 10_000_000)}`,
      displayName: 'Receipt Target',
      phoneE164: null,
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
      body: 'Hi there',
      sentByUserId: null,
    });
    const wamid = `wamid.${randomUUID()}`;
    await commerceInboxRepository.settleOutbound({
      orgId: t.orgId,
      messageId: message.id,
      status: 'sent',
      providerMessageId: wamid,
    });
    return { messageId: message.id, wamid };
  }

  async function messageState(messageId: string): Promise<{
    status: string;
    pricing_category: string | null;
    provider_pricing_category: string | null;
    billable: boolean | null;
    provider_conversation_id: string | null;
  }> {
    return db
      .selectFrom('commerce_messages')
      .select([
        'status',
        'pricing_category',
        'provider_pricing_category',
        'billable',
        'provider_conversation_id',
      ])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
  }

  it('normalizes a receipt and drops a status word it has never met', () => {
    const receipts = whatsappInboundAdapter.normalizeReceipts(
      receiptEntry('waba-x', {
        id: 'wamid.1',
        status: 'delivered',
        pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' },
        conversation: { id: 'conv-1' },
      }),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: 'delivered',
      pricingCategory: 'marketing',
      billable: true,
      providerConversationId: 'conv-1',
    });

    // A word this build cannot place in the never-goes-backwards ordering. Writing a guess could
    // freeze the message's real progression, so the receipt yields nothing.
    const unknown = whatsappInboundAdapter.normalizeReceipts(
      receiptEntry('waba-x', { id: 'wamid.2', status: 'warning' }),
    );
    expect(unknown).toEqual([]);
  });

  it('keeps three-valued billing: no pricing block is null, not free', () => {
    const receipts = whatsappInboundAdapter.normalizeReceipts(
      receiptEntry('waba-x', { id: 'wamid.3', status: 'sent' }),
    );
    expect(receipts[0]?.billable).toBeNull();
    expect(receipts[0]?.pricingCategory).toBeNull();
  });

  it('never walks a delivery status backwards, and lets failed win from anywhere', async () => {
    const t = await tenant();
    const { messageId, wamid } = await sentMessage(t);

    const apply = async (status: string): Promise<void> => {
      const receipts = whatsappInboundAdapter.normalizeReceipts(
        receiptEntry(t.wabaId, { id: wamid, status }),
      );
      await commerceInboundService.handleReceipt(receipts[0]!);
    };

    await apply('read');
    // Meta guarantees nothing about receipt order — the late `delivered` is ordinary traffic.
    await apply('delivered');
    expect((await messageState(messageId)).status).toBe('read');

    await apply('failed');
    expect((await messageState(messageId)).status).toBe('failed');
    await apply('delivered');
    expect((await messageState(messageId)).status).toBe('failed');
  });

  it('records pricing when a receipt carries it and keeps it when the next one does not', async () => {
    const t = await tenant();
    const { messageId, wamid } = await sentMessage(t);

    const priced = whatsappInboundAdapter.normalizeReceipts(
      receiptEntry(t.wabaId, {
        id: wamid,
        status: 'delivered',
        pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' },
        conversation: { id: 'conv-9' },
      }),
    );
    await commerceInboundService.handleReceipt(priced[0]!);

    const bare = whatsappInboundAdapter.normalizeReceipts(
      receiptEntry(t.wabaId, { id: wamid, status: 'read' }),
    );
    await commerceInboundService.handleReceipt(bare[0]!);

    const state = await messageState(messageId);
    expect(state.status).toBe('read');
    // COALESCE, not overwrite: blanking these turns a priced message back into an unpriced one and
    // loses it from the bill.
    expect(state.pricing_category).toBe('marketing');
    expect(state.billable).toBe(true);
    expect(state.provider_conversation_id).toBe('conv-9');
  });

  it('attributes a charge it cannot name instead of rounding it into a category', async () => {
    const t = await tenant();
    const { messageId, wamid } = await sentMessage(t);

    const receipts = whatsappInboundAdapter.normalizeReceipts(
      receiptEntry(t.wabaId, {
        id: wamid,
        status: 'delivered',
        pricing: { billable: true, pricing_model: 'PMP', category: 'quantum_tier' },
      }),
    );
    await commerceInboundService.handleReceipt(receipts[0]!);

    const state = await messageState(messageId);
    expect(state.pricing_category).toBeNull();
    expect(state.provider_pricing_category).toBe('quantum_tier');
    expect(state.billable).toBe(true);
  });

  it('sums a billing period into the buckets an invoice needs', async () => {
    const t = await tenant();
    const marketing = await sentMessage(t);
    const unnamed = await sentMessage(t);
    const free = await sentMessage(t);
    await sentMessage(t); // stays unpriced: sent, and no receipt ever arrives

    const apply = async (status: Record<string, unknown>): Promise<void> => {
      const receipts = whatsappInboundAdapter.normalizeReceipts(receiptEntry(t.wabaId, status));
      await commerceInboundService.handleReceipt(receipts[0]!);
    };
    await apply({
      id: marketing.wamid,
      status: 'delivered',
      pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' },
    });
    await apply({
      id: unnamed.wamid,
      status: 'delivered',
      pricing: { billable: true, pricing_model: 'PMP', category: 'quantum_tier' },
    });
    await apply({
      id: free.wamid,
      status: 'delivered',
      pricing: { billable: false, pricing_model: 'CBP', category: 'service' },
    });

    const summary = await commerceInboxRepository.costSummary({
      orgId: t.orgId,
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    expect(summary.billableByCategory.marketing).toBe(1);
    expect(summary.billableByCategory.utility).toBe(0);
    // Its own line: a charge that happened and cannot be named yet. Folding it into a category
    // misstates that category; dropping it understates the total.
    expect(summary.billableUncategorized).toBe(1);
    expect(summary.freeMessages).toBe(1);
    // The discrepancy line — Meta will bill this one and this summary cannot yet.
    expect(summary.unpricedMessages).toBe(1);
  });

  it('drops a receipt for an account nobody connected', async () => {
    const receipts = whatsappInboundAdapter.normalizeReceipts(
      receiptEntry(`waba-unconnected-${randomUUID().slice(0, 8)}`, {
        id: 'wamid.stranger',
        status: 'delivered',
      }),
    );
    // Dropped with a warning rather than defaulted into anyone's data — same rule as inbound.
    await expect(commerceInboundService.handleReceipt(receipts[0]!)).resolves.toBeUndefined();
  });
});
