import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';
import type { Conversation, Message } from '@stewra/shared-types';

/**
 * TEXTING THE BUSINESS INBOX — the headline surface of the commerce plane, and the one place where a
 * conversational turn can put words in front of somebody else's customer.
 *
 * What this suite is actually guarding is a single sentence: **nothing reaches a customer that the
 * user did not explicitly approve, addressed to a thread that is really theirs.** Every case below is
 * a way that could stop being true — a proposal that sends itself, a "yes" that resolves against the
 * wrong thread, a classifier id that belongs to another tenant, a viewer with no send rights, a
 * window that has already closed.
 *
 * Nothing is stood in for on our side of the wire. Real `unifiedConfig` parsing a real environment,
 * real turn orchestration through `stewraConversationService`, the real turn-intent registry, real
 * `stewra_test` Postgres, real vault encryption, and a real inbound webhook (real HMAC, real
 * `express.raw()`) to open the service window — because a fixture that INSERTed a conversation row
 * directly would be asserting against a window this code never actually opened.
 *
 * The two things outside our boundary are real HTTP servers, not patched functions:
 *   - Meta's Graph, so "was a message sent, exactly once, to whom, saying what" is answerable.
 *   - An OpenAI-compatible model endpoint, so the classifier's output is a SCRIPT. That is the point:
 *     the model is the untrusted input here, and a test that could not make it lie could not prove
 *     that a lie is caught.
 */

const APP_HMAC = randomBytes(32).toString('hex');
const MODEL_ID = 'commerce-intent-test-model';

// ---------------------------------------------------------------------------------------------
// Meta's Graph, as a real server. Every send lands here and nowhere else.
// ---------------------------------------------------------------------------------------------

interface SendCall {
  readonly phoneNumberId: string;
  readonly to: string;
  readonly body: string;
}

/** Every message Graph was asked to deliver. Asserted empty on every path that must not send. */
const sends: SendCall[] = [];

const graph: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter((p) => p.length > 0);
    // /v{version}/{phone-number-id}/messages
    const phoneNumberId = parts[1] ?? '';
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      to?: string;
      text?: { body?: string };
    };
    sends.push({
      phoneNumberId,
      to: payload.to ?? '',
      body: payload.text?.body ?? '',
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: `wamid.${randomUUID()}` }] }));
  });
});
await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
const graphOrigin = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;

// ---------------------------------------------------------------------------------------------
// The model, as a real OpenAI-compatible server. A test hands it the exact answer to give.
// ---------------------------------------------------------------------------------------------

/** What the model returns for the next completion. A test sets this before driving a turn. */
let scriptedReply = '{"intent":"none"}';
/** The system prompt of every completion the model was asked for — proves the pre-filter's work. */
const modelCalls: string[] = [];

const model: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: { role: string; content: string }[];
    };
    modelCalls.push(body.messages?.[0]?.content ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: 0,
        model: MODEL_ID,
        choices: [
          { index: 0, message: { role: 'assistant', content: scriptedReply }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  });
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const modelOrigin = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;

// ---------------------------------------------------------------------------------------------
// Config, from the environment exactly as a deploy does it — pinned before the graph is imported.
// ---------------------------------------------------------------------------------------------

process.env['META_COMMERCE_ENABLED'] = 'true';
process.env['META_COMMERCE_APP_ID'] = '100000000000001';
process.env['META_COMMERCE_APP_SECRET'] = APP_HMAC;
process.env['META_COMMERCE_CONFIG_ID'] = '200000000000002';
process.env['META_COMMERCE_VERIFY_TOKEN'] = `verify-${randomBytes(8).toString('hex')}`;
process.env['META_COMMERCE_GRAPH_BASE_URL'] = graphOrigin;
// The Claude CLI is the default provider and would talk to a real subscription; name the
// OpenAI-compatible adapter explicitly and point it at the scripted endpoint above.
process.env['MODEL_PREFER_CLAUDE_CLI'] = 'false';
process.env['MODEL_PROVIDER'] = 'openai';
process.env['MODEL_ID'] = MODEL_ID;
process.env['OPENAI_API_KEY'] = `test-${randomUUID()}`;
process.env['MODEL_BASE_URL'] = `${modelOrigin}/v1`;
// The runner tool gets first refusal on every turn and would otherwise consume scripted replies
// meant for the commerce classifier. Off is its default; pinning it says so out loud.
process.env['RUNNER_ENABLED'] = 'false';
// VOICE_ENABLED stays off (its default), so a turn produces text and no clip. UPLOADS_DIR is still
// required by the media service the turn orchestrator imports.
process.env['UPLOADS_DIR'] = mkdtempSync(join(tmpdir(), 'stewra-commerce-intent-'));

const database = (await import('../database/index.js')) as {
  db: typeof dbType;
  closeDb: typeof closeDbType;
};
const { db } = database;
const { errorHandler } = await import('../middleware/errorHandler.js');
const metaWebhookRoutes = (await import('../commerce/routes/metaWebhook.js')).default;
const { organizationRepository } = await import(
  '../commerce/repositories/organizationRepository.js'
);
const { conversationRepository } = await import('../repositories/conversationRepository.js');
const { messageRepository } = await import('../repositories/messageRepository.js');
const { stewraConversationService } = await import('../services/stewraConversationService.js');
const { commerceIntentService } = await import(
  '../commerce/services/commerceIntentService.js'
);
const { commerceProposalExecutorRegistry, turnIntentRegistry } = await import(
  '../ports/turnIntent.js'
);
const { vault } = await import('../control-plane/vault/vault.js');
const { config } = await import('../config/unifiedConfig.js');
const messagesRoutes = (await import('../routes/messages.js')).default;

// The two registrations `app.ts` performs at the composition root. Done here rather than by importing
// createApp() because this suite drives the turn orchestrator directly — but they are the SAME calls,
// so a handler that failed to satisfy either port interface would fail to compile here too.
turnIntentRegistry.register(commerceIntentService);
commerceProposalExecutorRegistry.register(commerceIntentService);

const webhookApp = express();
webhookApp.use('/webhooks/meta', metaWebhookRoutes);
webhookApp.use(errorHandler);
const webhookServer = webhookApp.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => webhookServer.once('listening', resolve));
const WEBHOOK = `http://127.0.0.1:${(webhookServer.address() as AddressInfo).port}`;

// The app's fallback surface: the real authenticated REST route behind the Send/Cancel card, with the
// real requireAuth → verified chain in front of it.
const apiApp = express();
apiApp.use(express.json());
apiApp.use('/messages', messagesRoutes);
apiApp.use(errorHandler);
const apiServer = apiApp.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => apiServer.once('listening', resolve));
const API = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

/** A real access token, signed the way authService signs one — so requireAuth verifies it for real. */
function bearer(userId: string): string {
  return `Bearer ${jwt.sign({ sub: userId, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
}

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdOrgs: string[] = [];
const createdConversations: string[] = [];
const deliveredMessageIds: string[] = [];

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** A tenant with a connected WhatsApp number, one real customer thread, and a Stewra-AI chat. */
interface Tenant {
  readonly userId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly phoneNumberId: string;
  readonly customerWaId: string;
  readonly chat: Conversation;
  /** The commerce conversation the inbound message opened. */
  readonly threadId: string;
}

function signature(body: string): string {
  return `sha256=${createHmac('sha256', APP_HMAC).update(Buffer.from(body)).digest('hex')}`;
}

/**
 * Wait for the inbound path to finish. The webhook acks with 200 BEFORE it does the work (Meta
 * retries a slow endpoint), so the row is not there the instant the request returns.
 */
async function waitForInbound(providerMessageId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = await db
      .selectFrom('commerce_messages')
      .select('id')
      .where('provider_message_id', '=', providerMessageId)
      .executeTakeFirst();
    if (row !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`inbound message ${providerMessageId} never landed`);
}

/** Meta's envelope for one inbound text, as it really arrives. */
function inboundEnvelope(params: {
  wabaId: string;
  from: string;
  text: string;
  profileName: string;
  /** Seconds since epoch. Older than 24h produces a thread whose reply window has already closed. */
  timestamp?: number;
}): string {
  const messageId = `wamid.${randomUUID()}`;
  // `commerce_inbound_messages` is install-wide (dedup is by provider id, not by tenant), so it
  // cannot be cleaned up by org like everything else. Tracked here so afterAll can still leave the
  // test database as it found it.
  deliveredMessageIds.push(messageId);
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: params.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [{ wa_id: params.from, profile: { name: params.profileName } }],
              messages: [
                {
                  id: messageId,
                  from: params.from,
                  timestamp: String(params.timestamp ?? Math.floor(Date.now() / 1000)),
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
}

async function tenant(
  opts: {
    role?: 'owner' | 'viewer';
    customerText?: string;
    customerName?: string;
    /** Seconds since epoch for the inbound. Defaults to now (an OPEN reply window). */
    inboundAt?: number;
  } = {},
): Promise<Tenant> {
  const user = await db
    .insertInto('users')
    .values({
      email: `commerce-intent-${randomUUID()}@stewra.invalid`,
      display_name: 'Commerce Intent Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(user.id);

  const orgName = 'Acme Coffee';
  const { org } = await organizationRepository.create({
    name: orgName,
    slug: `acme-${randomUUID().slice(0, 8)}`,
    createdBy: user.id,
  });
  createdOrgs.push(org.id);

  if (opts.role === 'viewer') {
    await db
      .updateTable('org_members')
      .set({ role: 'viewer' })
      .where('org_id', '=', org.id)
      .where('user_id', '=', user.id)
      .execute();
  }

  const wabaId = `1${Math.floor(Math.random() * 1_000_000_000_000_000)}`;
  const phoneNumberId = `p-${randomUUID().slice(0, 8)}`;
  // A REAL vault round-trip: the send path resolves the credential through it, so a fake ref here
  // would make every send fail for a reason that has nothing to do with what is being tested.
  const credentialRef = await vault.put(`token-${randomUUID()}`);
  await db
    .insertInto('channel_accounts')
    .values({
      org_id: org.id,
      platform: 'whatsapp_cloud',
      external_account_id: wabaId,
      phone_number_id: phoneNumberId,
      display_name: '+1 555 010 0100',
      credential_ref: credentialRef,
      meta: JSON.stringify({}),
    })
    .execute();

  // The customer writes first — through the real webhook, so the contact, the thread and the 24-hour
  // service window are all created by the production inbound path.
  const customerWaId = `1555${Math.floor(Math.random() * 10_000_000)}`;
  const body = inboundEnvelope({
    wabaId,
    from: customerWaId,
    text: opts.customerText ?? 'do you deliver on sundays?',
    profileName: opts.customerName ?? 'Dana',
    ...(opts.inboundAt === undefined ? {} : { timestamp: opts.inboundAt }),
  });
  const res = await request(WEBHOOK)
    .post('/webhooks/meta')
    .set('Content-Type', 'application/json')
    .set('x-hub-signature-256', signature(body))
    .send(body);
  expect(res.status).toBe(200);
  await waitForInbound(deliveredMessageIds[deliveredMessageIds.length - 1] ?? '');

  const thread = await db
    .selectFrom('commerce_conversations')
    .select('id')
    .where('org_id', '=', org.id)
    .executeTakeFirstOrThrow();

  const chat = await conversationRepository.getOrCreateStewra(user.id);
  createdConversations.push(chat.id);

  return {
    userId: user.id,
    orgId: org.id,
    orgName,
    phoneNumberId,
    customerWaId,
    chat,
    threadId: thread.id,
  };
}

/**
 * One full Talk-to-Stewra turn, driven the way `messageService` drives it: persist the user's
 * message, then let the orchestrator produce and persist the assistant's. Returns the assistant
 * message, including whatever proposal got attached to it.
 */
async function turn(t: Tenant, text: string): Promise<Message> {
  const userMessage = await messageRepository.create({
    conversationId: t.chat.id,
    senderId: t.userId,
    senderKind: 'user',
    type: 'text',
    content: text,
  });
  return stewraConversationService.generateReply(t.userId, t.chat, userMessage, 'stewra_chat');
}

/** Outbound rows in an org's commerce inbox, oldest first. */
async function outbound(orgId: string): Promise<{ body: string; status: string }[]> {
  return db
    .selectFrom('commerce_messages')
    .select(['body', 'status'])
    .where('org_id', '=', orgId)
    .where('direction', '=', 'outbound')
    .orderBy('created_at', 'asc')
    .execute();
}

beforeEach(() => {
  sends.length = 0;
  modelCalls.length = 0;
  scriptedReply = '{"intent":"none"}';
});

afterAll(async () => {
  turnIntentRegistry.reset();
  commerceProposalExecutorRegistry.reset();
  await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  await new Promise<void>((resolve) => model.close(() => resolve()));

  if (createdConversations.length > 0) {
    await db
      .deleteFrom('messages')
      .where('conversation_id', 'in', createdConversations)
      .execute();
    await db
      .deleteFrom('conversation_participants')
      .where('conversation_id', 'in', createdConversations)
      .execute();
    await db.deleteFrom('conversations').where('id', 'in', createdConversations).execute();
  }
  if (createdOrgs.length > 0) {
    await db.deleteFrom('commerce_messages').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_conversations').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_contacts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('channel_accounts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_active_orgs').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    // Before the users: organizations.created_by is ON DELETE RESTRICT on purpose.
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (deliveredMessageIds.length > 0) {
    await db
      .deleteFrom('commerce_inbound_messages')
      .where('provider_message_id', 'in', deliveredMessageIds)
      .execute();
  }
  if (createdUsers.length > 0) {
    await db
      .deleteFrom('users')
      .where('id', 'in', createdUsers)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id'))),
      )
      .execute();
  }
  await database.closeDb();
});

// ---------------------------------------------------------------------------------------------
// Reading the inbox — no side effects, ever
// ---------------------------------------------------------------------------------------------

describe('reading an organization’s inbox by text', () => {
  it('summarises the live threads without sending anything', async () => {
    const t = await tenant({ customerName: 'Dana', customerText: 'do you deliver on sundays?' });
    scriptedReply = JSON.stringify({ intent: 'inbox_summary' });

    const reply = await turn(t, "what's in the inbox?");

    expect(reply.content).toContain('Dana');
    expect(reply.content).toContain('do you deliver on sundays?');
    expect(reply.proposedCommerceReply).toBeNull();
    expect(sends).toHaveLength(0);
  });

  it('never calls the model for a turn with nothing to do with the business', async () => {
    // The pre-filter is not an optimisation here, it is what keeps an ordinary chat turn from being
    // routed through a classifier that can propose a customer-facing action at all.
    const t = await tenant();
    await turn(t, 'remind me to buy milk tomorrow');

    // One call, and it is the advice-only agent's — the classifier never ran.
    const classifierCalls = modelCalls.filter((prompt) =>
      prompt.includes('business-inbox router for Stewra'),
    );
    expect(classifierCalls).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The confirm gate — the whole point of the feature
// ---------------------------------------------------------------------------------------------

describe('replying to a customer', () => {
  it('PROPOSES rather than sends, and sends nothing until confirmed', async () => {
    const t = await tenant();
    scriptedReply = JSON.stringify({
      intent: 'reply_request',
      conversationId: t.threadId,
      body: 'Yes — we deliver every Sunday between 9 and 5.',
      reply: 'Ready to send to Dana. Confirm?',
    });

    const proposed = await turn(t, 'reply to that customer about sunday delivery');

    expect(proposed.proposedCommerceReply).not.toBeNull();
    expect(proposed.proposedCommerceReply?.status).toBe('pending');
    expect(proposed.proposedCommerceReply?.orgId).toBe(t.orgId);
    expect(proposed.proposedCommerceReply?.conversationId).toBe(t.threadId);
    expect(proposed.proposedCommerceReply?.contactName).toBe('Dana');
    expect(proposed.proposedCommerceReply?.body).toBe(
      'Yes — we deliver every Sunday between 9 and 5.',
    );
    // Nothing left the building, and nothing was even queued.
    expect(sends).toHaveLength(0);
    expect(await outbound(t.orgId)).toHaveLength(0);
  });

  it('sends exactly once on an explicit yes, and settles the proposal to `sent`', async () => {
    const t = await tenant();
    scriptedReply = JSON.stringify({
      intent: 'reply_request',
      conversationId: t.threadId,
      body: 'Yes — we deliver every Sunday between 9 and 5.',
      reply: 'Ready to send to Dana. Confirm?',
    });
    const proposed = await turn(t, 'reply to that customer about sunday delivery');

    scriptedReply = JSON.stringify({ intent: 'confirm_reply', reply: 'Sent to Dana.' });
    const confirmed = await turn(t, 'yes send it');

    expect(sends).toHaveLength(1);
    expect(sends[0]?.phoneNumberId).toBe(t.phoneNumberId);
    expect(sends[0]?.to).toBe(t.customerWaId);
    expect(sends[0]?.body).toBe('Yes — we deliver every Sunday between 9 and 5.');

    // The confirming turn carries no NEW proposal — a confirmation is not a fresh request.
    expect(confirmed.proposedCommerceReply).toBeNull();

    // The proposal card the user tapped/answered is now terminal, and points at the message it became.
    const settled = await messageRepository.findById(proposed.id, t.userId);
    expect(settled?.proposedCommerceReply?.status).toBe('sent');
    expect(settled?.proposedCommerceReply?.messageId).not.toBeNull();

    const rows = await outbound(t.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('sent');
    expect(rows[0]?.body).toBe('Yes — we deliver every Sunday between 9 and 5.');
  });

  it('sends nothing on a decline, and settles the proposal to `cancelled`', async () => {
    const t = await tenant();
    scriptedReply = JSON.stringify({
      intent: 'reply_request',
      conversationId: t.threadId,
      body: 'Yes — we deliver every Sunday.',
      reply: 'Ready to send to Dana. Confirm?',
    });
    const proposed = await turn(t, 'reply to that customer');

    scriptedReply = JSON.stringify({ intent: 'decline_reply', reply: 'Left it unsent.' });
    await turn(t, 'no, leave it');

    expect(sends).toHaveLength(0);
    expect(await outbound(t.orgId)).toHaveLength(0);
    const settled = await messageRepository.findById(proposed.id, t.userId);
    expect(settled?.proposedCommerceReply?.status).toBe('cancelled');
  });

  it('supersedes the old wording on a revision, so a later yes cannot send the corrected-away text', async () => {
    const t = await tenant();
    scriptedReply = JSON.stringify({
      intent: 'reply_request',
      conversationId: t.threadId,
      body: 'Yes, sundays are fine.',
      reply: 'Confirm?',
    });
    const first = await turn(t, 'reply to that customer');

    scriptedReply = JSON.stringify({
      intent: 'revise_reply',
      body: 'Yes — Sunday delivery runs 9am to 5pm.',
      reply: 'Updated. Confirm?',
    });
    const revised = await turn(t, 'say it more warmly and give the hours');

    // The superseded card is terminal, so it can never be the one a "yes" resolves against.
    const supersededCard = await messageRepository.findById(first.id, t.userId);
    expect(supersededCard?.proposedCommerceReply?.status).toBe('cancelled');
    expect(revised.proposedCommerceReply?.status).toBe('pending');
    expect(revised.proposedCommerceReply?.body).toBe('Yes — Sunday delivery runs 9am to 5pm.');

    scriptedReply = JSON.stringify({ intent: 'confirm_reply', reply: 'Sent.' });
    await turn(t, 'yes');

    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toBe('Yes — Sunday delivery runs 9am to 5pm.');
  });

  it('answers a bare “yes” with nothing to confirm by saying so, not by inventing a send', async () => {
    const t = await tenant();
    scriptedReply = JSON.stringify({ intent: 'confirm_reply', reply: '' });

    const reply = await turn(t, 'yes, send that reply to the customer');

    expect(sends).toHaveLength(0);
    expect(reply.content).toContain('nothing waiting');
  });
});

// ---------------------------------------------------------------------------------------------
// The model is untrusted input
// ---------------------------------------------------------------------------------------------

describe('ids the classifier produces are resolved against real rows', () => {
  it('refuses a conversation id belonging to ANOTHER tenant — asks instead of sending', async () => {
    const mine = await tenant();
    const theirs = await tenant({ customerName: 'Someone Else' });

    // The failure this rules out: a classifier that has seen another tenant's id (from a prompt
    // injection in an inbound customer message, say) naming it as the target. It is not in the live
    // list for the active org, so it must resolve to nothing.
    scriptedReply = JSON.stringify({
      intent: 'reply_request',
      conversationId: theirs.threadId,
      body: 'Your order is on its way.',
      reply: 'Sending now.',
    });

    const reply = await turn(mine, 'reply to that customer');

    expect(reply.proposedCommerceReply).toBeNull();
    expect(sends).toHaveLength(0);
    expect(await outbound(theirs.orgId)).toHaveLength(0);
    expect(await outbound(mine.orgId)).toHaveLength(0);
    // A question, not a silent no-op — the user has to be able to tell nothing happened.
    expect(reply.content).toContain('Which conversation');
  });

  it('refuses an id that exists nowhere at all', async () => {
    const t = await tenant();
    scriptedReply = JSON.stringify({
      intent: 'reply_request',
      conversationId: randomUUID(),
      body: 'hello',
      reply: 'Sending now.',
    });

    const reply = await turn(t, 'reply to that customer');

    expect(reply.proposedCommerceReply).toBeNull();
    expect(sends).toHaveLength(0);
    expect(reply.content).toContain('Which conversation');
  });

  it('refuses an organization id the user is not a member of', async () => {
    const mine = await tenant();
    const theirs = await tenant();
    scriptedReply = JSON.stringify({ intent: 'switch_org', orgId: theirs.orgId, reply: 'Switched.' });

    const reply = await turn(mine, 'switch to that other business');

    expect(reply.content).toContain('Which business');
    // The active org is untouched: nothing was written on the strength of a model-produced id.
    const active = await db
      .selectFrom('commerce_active_orgs')
      .select('org_id')
      .where('user_id', '=', mine.userId)
      .executeTakeFirst();
    expect(active?.org_id).not.toBe(theirs.orgId);
  });
});

// ---------------------------------------------------------------------------------------------
// The gates that apply to a send regardless of what the user or the model asked for
// ---------------------------------------------------------------------------------------------

describe('gates on the conversational send path', () => {
  it('will not let a VIEWER message customers, even though the classifier agreed to', async () => {
    // The role hierarchy has to have the same teeth on the surface the product leads with as it does
    // on the REST route, or it is decorative.
    const t = await tenant({ role: 'viewer' });
    scriptedReply = JSON.stringify({
      intent: 'reply_request',
      conversationId: t.threadId,
      body: 'Yes, we deliver on sundays.',
      reply: 'Sending now.',
    });

    const reply = await turn(t, 'reply to that customer');

    expect(reply.proposedCommerceReply).toBeNull();
    expect(sends).toHaveLength(0);
    expect(reply.content).toContain('read-only');
  });

  it('refuses at PROPOSAL time when the 24-hour window has already closed', async () => {
    // Meta accepts a free-form message outside the window and never delivers it. Proposing one would
    // be asking the user to approve something that cannot happen.
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 48 * 60 * 60;
    const t = await tenant({ inboundAt: twoDaysAgo });
    scriptedReply = JSON.stringify({
      intent: 'reply_request',
      conversationId: t.threadId,
      body: 'Sorry for the slow reply!',
      reply: 'Sending now.',
    });

    const reply = await turn(t, 'reply to that customer');

    expect(reply.proposedCommerceReply).toBeNull();
    expect(sends).toHaveLength(0);
    expect(reply.content).toContain('24 hours');
    expect(reply.content).toContain('template');
  });
});

// ---------------------------------------------------------------------------------------------
// The app's Send button — the fallback surface, and the SAME executor the conversational "yes" uses
// ---------------------------------------------------------------------------------------------

describe('POST /messages/:id/confirm-commerce-reply', () => {
  /** Propose a reply conversationally and hand back the assistant message carrying the card. */
  async function proposal(t: Tenant, body = 'Yes — we deliver every Sunday.'): Promise<Message> {
    scriptedReply = JSON.stringify({
      intent: 'reply_request',
      conversationId: t.threadId,
      body,
      reply: 'Ready to send to Dana. Confirm?',
    });
    return turn(t, 'reply to that customer about sunday delivery');
  }

  it('sends exactly once and returns the settled message', async () => {
    const t = await tenant();
    const proposed = await proposal(t);

    const res = await request(API)
      .post(`/messages/${proposed.id}/confirm-commerce-reply`)
      .set('Authorization', bearer(t.userId))
      .send({ action: 'send' });

    expect(res.status).toBe(200);
    // The response is what re-renders the card, so it has to already carry the terminal status —
    // a client that had to re-fetch would show a Send button for a message that is already gone.
    const message = res.body.data.message as Message;
    expect(message.proposedCommerceReply?.status).toBe('sent');
    expect(message.proposedCommerceReply?.messageId).not.toBeNull();

    expect(sends).toHaveLength(1);
    expect(sends[0]?.phoneNumberId).toBe(t.phoneNumberId);
    expect(sends[0]?.to).toBe(t.customerWaId);
    expect(sends[0]?.body).toBe('Yes — we deliver every Sunday.');
    expect(await outbound(t.orgId)).toHaveLength(1);
  });

  it('sends nothing on cancel, and settles the proposal to `cancelled`', async () => {
    const t = await tenant();
    const proposed = await proposal(t);

    const res = await request(API)
      .post(`/messages/${proposed.id}/confirm-commerce-reply`)
      .set('Authorization', bearer(t.userId))
      .send({ action: 'cancel' });

    expect(res.status).toBe(200);
    expect((res.body.data.message as Message).proposedCommerceReply?.status).toBe('cancelled');
    expect(sends).toHaveLength(0);
    expect(await outbound(t.orgId)).toHaveLength(0);
  });

  it('refuses a SECOND send of the same proposal — a double-tap cannot double-message a customer', async () => {
    const t = await tenant();
    const proposed = await proposal(t);
    const url = `/messages/${proposed.id}/confirm-commerce-reply`;

    const first = await request(API)
      .post(url)
      .set('Authorization', bearer(t.userId))
      .send({ action: 'send' });
    expect(first.status).toBe(200);

    const second = await request(API)
      .post(url)
      .set('Authorization', bearer(t.userId))
      .send({ action: 'send' });

    expect(second.status).toBe(400);
    expect(second.body.error.message as string).toContain('already sent');
    expect(sends).toHaveLength(1);
    expect(await outbound(t.orgId)).toHaveLength(1);
  });

  it('refuses a cancelled proposal, so a stale card cannot resurrect a declined reply', async () => {
    const t = await tenant();
    const proposed = await proposal(t);
    const url = `/messages/${proposed.id}/confirm-commerce-reply`;

    await request(API).post(url).set('Authorization', bearer(t.userId)).send({ action: 'cancel' });
    const revived = await request(API)
      .post(url)
      .set('Authorization', bearer(t.userId))
      .send({ action: 'send' });

    expect(revived.status).toBe(400);
    expect(sends).toHaveLength(0);
  });

  it('refuses a message that carries no customer reply at all', async () => {
    const t = await tenant();
    const plain = await turn(t, 'remind me to buy milk tomorrow');

    const res = await request(API)
      .post(`/messages/${plain.id}/confirm-commerce-reply`)
      .set('Authorization', bearer(t.userId))
      .send({ action: 'send' });

    expect(res.status).toBe(400);
    expect(sends).toHaveLength(0);
  });

  it('will not let ANOTHER user confirm a proposal in someone else’s chat', async () => {
    // The proposal names an org and a thread, but the authority to send it belongs to the person who
    // was offered the card — not to anyone who can guess a message id.
    const mine = await tenant();
    const stranger = await tenant();
    const proposed = await proposal(mine);

    const res = await request(API)
      .post(`/messages/${proposed.id}/confirm-commerce-reply`)
      .set('Authorization', bearer(stranger.userId))
      .send({ action: 'send' });

    // 403, not 404: `assertParticipant` refuses before the proposal is ever looked at, which is the
    // same gate `confirmEmailAction`/`confirmRunnerSessionAction` sit behind.
    expect(res.status).toBe(403);
    expect(sends).toHaveLength(0);
    expect(await outbound(mine.orgId)).toHaveLength(0);
  });

  it('rejects an unauthenticated tap outright', async () => {
    const t = await tenant();
    const proposed = await proposal(t);

    const res = await request(API)
      .post(`/messages/${proposed.id}/confirm-commerce-reply`)
      .send({ action: 'send' });

    expect(res.status).toBe(401);
    expect(sends).toHaveLength(0);
  });

  it('rejects an action that is neither send nor cancel', async () => {
    const t = await tenant();
    const proposed = await proposal(t);

    const res = await request(API)
      .post(`/messages/${proposed.id}/confirm-commerce-reply`)
      .set('Authorization', bearer(t.userId))
      .send({ action: 'deliver' });

    expect(res.status).toBe(400);
    expect(sends).toHaveLength(0);
  });
});
