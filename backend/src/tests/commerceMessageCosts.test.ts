import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import request from 'supertest';
import type { MessagePricingCategory } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { db, closeDb } from '../database/index.js';
import { errorHandler } from '../middleware/errorHandler.js';
import orgRoutes from '../tenancy/routes/organizations.js';
import commerceOrgRoutes from '../commerce/routes/orgSurface.js';
import { channelAccountRepository } from '../commerce/repositories/channelAccountRepository.js';
import { commerceInboxRepository } from '../commerce/repositories/commerceInboxRepository.js';
import { organizationRepository } from '../tenancy/repositories/organizationRepository.js';
import { rateCardRepository } from '../commerce/repositories/rateCardRepository.js';
import { commerceInboundService } from '../commerce/services/commerceInboundService.js';

/**
 * Per-message cost in real currency (migration 051) — Phase 2.2.
 *
 * The receipts here run through the REAL webhook path (`commerceInboundService.handleReceipt`),
 * because the properties under test are exactly the ones a shortcut would fake: a replayed webhook
 * must not double-bill, a receipt with no pricing must leave NO row (keeping `unpricedMessages`
 * honest), conversation pricing must charge once per provider conversation, and every gap in the
 * rating inputs must land in its own visible `unrated_*` state instead of becoming a number.
 */

const app = express();
app.use(express.json());
app.use('/orgs', orgRoutes);
app.use('/orgs/:orgId', commerceOrgRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdOrgs: string[] = [];
const createdCards: string[] = [];

// One never-real currency for the whole run, so reruns and parallel suites cannot fight over the
// one-live-card-per-currency slot.
const CUR = `Z${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}`;

async function createOwner(): Promise<{ id: string; auth: string; orgId: string }> {
  const row = await db
    .insertInto('users')
    .values({
      email: `costs-${randomUUID()}@stewra.invalid`,
      display_name: 'Costs Tester',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  const { org } = await organizationRepository.create({
    name: 'Costs Bakery',
    slug: `costs-${randomUUID().slice(0, 8)}`,
    createdBy: row.id,
  });
  createdOrgs.push(org.id);
  const auth = `Bearer ${jwt.sign({ sub: row.id, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
  return { id: row.id, auth, orgId: org.id };
}

/** A connected WABA, a contact, and one sent message awaiting its receipt. */
async function createSentMessage(params: {
  orgId: string;
  billingCurrency: string | null;
  phoneE164?: string;
}): Promise<{ wabaId: string; messageId: string; providerMessageId: string; conversationId: string }> {
  const wabaId = `waba-${randomUUID()}`;
  const { account } = await channelAccountRepository.upsert({
    orgId: params.orgId,
    platform: 'whatsapp_cloud',
    externalAccountId: wabaId,
    phoneNumberId: `pn-${randomUUID().slice(0, 8)}`,
    displayName: '+15550001111',
    displayPhoneNumber: '+15550001111',
    // The column is a uuid pointing into the vault; nothing in this suite ever decrypts it, so a
    // random uuid that resolves to no secret is the honest shape of "credential not under test".
    credentialRef: randomUUID(),
    credentialExpiresAt: null,
    billingCurrency: params.billingCurrency,
    meta: {},
  });
  const phone = params.phoneE164 ?? '+14155550100';
  const contactId = await commerceInboxRepository.upsertContact({
    orgId: params.orgId,
    platform: 'whatsapp_cloud',
    externalId: phone.slice(1),
    displayName: 'Casey Customer',
    phoneE164: phone,
  });
  const conversationId = await commerceInboxRepository.upsertConversation({
    orgId: params.orgId,
    channelAccountId: account.id,
    contactId,
    platform: 'whatsapp_cloud',
  });
  const message = await commerceInboxRepository.recordOutbound({
    orgId: params.orgId,
    conversationId,
    platform: 'whatsapp_cloud',
    body: 'Your order shipped.',
    sentByUserId: null,
  });
  const providerMessageId = `wamid.${randomUUID()}`;
  await commerceInboxRepository.settleOutbound({
    orgId: params.orgId,
    messageId: message.id,
    status: 'sent',
    providerMessageId,
  });
  return { wabaId, messageId: message.id, providerMessageId, conversationId };
}

async function deliverReceipt(params: {
  wabaId: string;
  providerMessageId: string;
  pricingCategory: MessagePricingCategory | null;
  billable: boolean | null;
  providerConversationId?: string | null;
}): Promise<void> {
  await commerceInboundService.handleReceipt({
    platform: 'whatsapp_cloud',
    externalAccountId: params.wabaId,
    providerMessageId: params.providerMessageId,
    status: 'delivered',
    failureReason: null,
    pricingCategory: params.pricingCategory,
    providerCategory: params.pricingCategory,
    pricingModel: params.pricingCategory === 'service' ? 'CBP' : 'PMP',
    billable: params.billable,
    providerConversationId: params.providerConversationId ?? null,
  });
}

async function costRows(orgId: string): Promise<
  Array<{
    message_id: string;
    state: string;
    amount_micros: string | null;
    rate_amount_micros: string | null;
    currency: string | null;
    rate_card_id: string | null;
  }>
> {
  return db
    .selectFrom('commerce_message_costs')
    .select(['message_id', 'state', 'amount_micros', 'rate_amount_micros', 'currency', 'rate_card_id'])
    .where('org_id', '=', orgId)
    .orderBy('priced_at', 'asc')
    .execute();
}

async function moneyBlock(owner: { auth: string; orgId: string }): Promise<{
  byCurrency: Record<string, { ratedMicros: string; ratedMessages: number; conversationDupMessages: number }>;
  freeMessages: number;
  unratedBillable: Record<string, number>;
  complete: boolean;
}> {
  const res = await request(API)
    .get(`/orgs/${owner.orgId}/costs`)
    .query({ from: '2020-01-01T00:00:00Z', to: '2099-01-01T00:00:00Z' })
    .set('Authorization', owner.auth);
  expect(res.status).toBe(200);
  return res.body.data.money;
}

beforeAll(async () => {
  const loader = await createOwner();
  const card = await rateCardRepository.loadCard({
    currency: CUR,
    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    sourceNote: 'test sheet',
    loadedByUserId: loader.id,
    rates: [
      { countryCallingCode: '1', pricingCategory: 'marketing', amountMicros: 25000n, unit: 'per_message' },
      { countryCallingCode: '1', pricingCategory: 'service', amountMicros: 40000n, unit: 'per_conversation' },
    ],
  });
  createdCards.push(card.id);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    // Rated messages now book their unreserved actuals onto the spend tables (Phase 2.3); the
    // ledger is trigger-enforced append-only, lifted only here in the harness for fixture cleanup.
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_spend_ledger DISABLE TRIGGER stewra_commerce_spend_ledger_append_only`.execute(trx);
      await trx.deleteFrom('commerce_spend_ledger').where('org_id', 'in', createdOrgs).execute();
      await sql`ALTER TABLE commerce_spend_ledger ENABLE TRIGGER stewra_commerce_spend_ledger_append_only`.execute(trx);
    });
    await db.deleteFrom('commerce_spend_periods').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_spend_caps').where('org_id', 'in', createdOrgs).execute();
    // Cost rows first (they FK both messages and rate cards), then the message chain, then orgs.
    await db.deleteFrom('commerce_message_costs').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_messages').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_conversations').where('org_id', 'in', createdOrgs).execute();
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
  await closeDb();
});

describe('rating from the delivery receipt', () => {
  it('prices a billable message from the live card, and a replayed webhook does not double-bill', async () => {
    const owner = await createOwner();
    const sent = await createSentMessage({ orgId: owner.orgId, billingCurrency: CUR });

    await deliverReceipt({ ...sent, pricingCategory: 'marketing', billable: true });
    // Meta retries webhooks for up to 7 days; the second arrival must change nothing.
    await deliverReceipt({ ...sent, pricingCategory: 'marketing', billable: true });

    const rows = await costRows(owner.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message_id: sent.messageId,
      state: 'rated',
      amount_micros: '25000',
      rate_amount_micros: '25000',
      currency: CUR,
    });
    expect(rows[0]?.rate_card_id).not.toBeNull();

    const money = await moneyBlock(owner);
    expect(money.byCurrency[CUR]).toEqual({
      ratedMicros: '25000',
      ratedMessages: 1,
      conversationDupMessages: 0,
    });
    expect(money.complete).toBe(true);
  });

  it('a receipt with no pricing block leaves NO row — and the period reads incomplete until priced', async () => {
    const owner = await createOwner();
    const sent = await createSentMessage({ orgId: owner.orgId, billingCurrency: CUR });

    await deliverReceipt({ ...sent, pricingCategory: null, billable: null });
    expect(await costRows(owner.orgId)).toHaveLength(0);
    // The message is visible as unpriced, not silently free: complete must be false.
    expect((await moneyBlock(owner)).complete).toBe(false);

    // The pricing arrives on a later receipt — rated from the merged row.
    await deliverReceipt({ ...sent, pricingCategory: 'marketing', billable: true });
    const rows = await costRows(owner.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('rated');
    expect((await moneyBlock(owner)).complete).toBe(true);
  });

  it('conversation pricing charges once: the second message in the conversation rates to zero', async () => {
    const owner = await createOwner();
    const first = await createSentMessage({ orgId: owner.orgId, billingCurrency: CUR });
    // Second message in the SAME conversation: reuse the same WABA by delivering to the same org
    // via a second outbound on the first conversation.
    const second = await commerceInboxRepository.recordOutbound({
      orgId: owner.orgId,
      conversationId: first.conversationId,
      platform: 'whatsapp_cloud',
      body: 'And a follow-up.',
      sentByUserId: null,
    });
    const secondProviderId = `wamid.${randomUUID()}`;
    await commerceInboxRepository.settleOutbound({
      orgId: owner.orgId,
      messageId: second.id,
      status: 'sent',
      providerMessageId: secondProviderId,
    });

    const conversation = `conv-${randomUUID()}`;
    await deliverReceipt({
      wabaId: first.wabaId,
      providerMessageId: first.providerMessageId,
      pricingCategory: 'service',
      billable: true,
      providerConversationId: conversation,
    });
    await deliverReceipt({
      wabaId: first.wabaId,
      providerMessageId: secondProviderId,
      pricingCategory: 'service',
      billable: true,
      providerConversationId: conversation,
    });

    const rows = await costRows(owner.orgId);
    expect(rows.map((r) => r.state).sort()).toEqual(['rated', 'rated_zero_conversation_dup']);
    const dup = rows.find((r) => r.state === 'rated_zero_conversation_dup');
    // The dup carries the rate it WOULD have cost (provenance) but adds nothing to the bill.
    expect(dup?.amount_micros).toBe('0');
    expect(dup?.rate_amount_micros).toBe('40000');

    const money = await moneyBlock(owner);
    expect(money.byCurrency[CUR]).toEqual({
      ratedMicros: '40000',
      ratedMessages: 1,
      conversationDupMessages: 1,
    });
    expect(money.complete).toBe(true);
  });
});

describe('the honest refusals', () => {
  it('an explicitly free message rates to zero without touching the card', async () => {
    const owner = await createOwner();
    const sent = await createSentMessage({ orgId: owner.orgId, billingCurrency: CUR });
    await deliverReceipt({ ...sent, pricingCategory: 'referral_conversion', billable: false });

    const rows = await costRows(owner.orgId);
    expect(rows[0]).toMatchObject({ state: 'free', amount_micros: '0', rate_card_id: null });
    const money = await moneyBlock(owner);
    expect(money.freeMessages).toBe(1);
    expect(money.complete).toBe(true);
  });

  it('each missing rating input lands in its own unrated state with a NULL amount', async () => {
    const owner = await createOwner();

    // Billable under a category this build cannot map.
    const noCategory = await createSentMessage({ orgId: owner.orgId, billingCurrency: CUR });
    await deliverReceipt({ ...noCategory, pricingCategory: null, billable: true });

    // A WABA that never reported its billing currency.
    const noCurrency = await createSentMessage({ orgId: owner.orgId, billingCurrency: null });
    await deliverReceipt({ ...noCurrency, pricingCategory: 'marketing', billable: true });

    // A recipient country the card does not list (+44; the card prices only '1').
    const noRate = await createSentMessage({
      orgId: owner.orgId,
      billingCurrency: CUR,
      phoneE164: '+442079460000',
    });
    await deliverReceipt({ ...noRate, pricingCategory: 'marketing', billable: true });

    const rows = await costRows(owner.orgId);
    const byMessage = new Map(rows.map((r) => [r.message_id, r]));
    expect(byMessage.get(noCategory.messageId)?.state).toBe('unrated_no_category');
    expect(byMessage.get(noCurrency.messageId)?.state).toBe('unrated_no_currency');
    expect(byMessage.get(noRate.messageId)?.state).toBe('unrated_no_rate');
    for (const row of rows) expect(row.amount_micros).toBeNull();

    const money = await moneyBlock(owner);
    expect(money.unratedBillable).toEqual({
      unrated_no_category: 1,
      unrated_no_currency: 1,
      unrated_no_country: 0,
      unrated_no_rate: 1,
    });
    // Three billable messages the bill cannot yet explain: the period must not read complete.
    expect(money.complete).toBe(false);
    // And the honest counts beside the money are untouched by rating: all three are billable.
    const res = await request(API)
      .get(`/orgs/${owner.orgId}/costs`)
      .query({ from: '2020-01-01T00:00:00Z', to: '2099-01-01T00:00:00Z' })
      .set('Authorization', owner.auth);
    expect(res.body.data.summary.unpricedMessages).toBe(0);
  });
});
