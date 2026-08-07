import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { sql } from 'kysely';
import { describe, it, expect, afterAll } from 'vitest';
import type { closeDb as closeDbType, db as dbType } from '../database/index.js';

/**
 * CLICK-TO-WHATSAPP OPT-IN — the door where the customer, not the business, creates the consent.
 *
 * The other two doors both rest on the organization's word: a member typing a contact in is vouching
 * for them, and an imported row carries whatever provenance the file claimed. This one does not need
 * to be believed. The customer sends a sentence from their own account saying what they agree to,
 * and Meta keeps a copy of it.
 *
 * Two mechanisms, and this suite exists largely to keep them apart, because they are unequal:
 *
 *   - **A LINK** puts an unguessable token in the prefilled text. Sending the message is an
 *     affirmative act by the person, in words that can be shown back to them, so it is recorded at
 *     whatever purpose the link declares — including `marketing`.
 *   - **A REFERRAL** is Meta saying the conversation began at an ad or a post. Tapping "Message us"
 *     is agreeing to a conversation, not subscribing to a campaign, so it is recorded as `service`
 *     no matter how the ad was worded. The test that pins this is the most important one here: an
 *     integration that quietly promoted ad clicks to marketing consent would assemble precisely the
 *     list the consent regime exists to refuse, and every individual step would look reasonable.
 *
 * Real Postgres, the real adapter, the real inbound service, the real router over real HTTP with a
 * real HMAC. The consent assertions are about ROWS, because the failure mode being guarded against
 * is not a crash — it is a permission that was recorded when nobody granted it.
 */

const APP_HMAC = randomBytes(32).toString('hex');

process.env['META_COMMERCE_ENABLED'] = 'true';
process.env['META_COMMERCE_APP_ID'] = '100000000000001';
process.env['META_COMMERCE_APP_SECRET'] = APP_HMAC;
process.env['META_COMMERCE_CONFIG_ID'] = '200000000000004';
process.env['META_COMMERCE_VERIFY_TOKEN'] = `verify-${randomBytes(8).toString('hex')}`;

const database = (await import('../database/index.js')) as {
  db: typeof dbType;
  closeDb: typeof closeDbType;
};
const { db } = database;
const { config } = await import('../config/unifiedConfig.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const orgRoutes = (await import('../commerce/routes/organizations.js')).default;
const metaWebhookRoutes = (await import('../commerce/routes/metaWebhook.js')).default;
const { organizationRepository } = await import(
  '../commerce/repositories/organizationRepository.js'
);
const { whatsappInboundAdapter } = await import('../commerce/services/inbound/whatsappAdapter.js');
const { commerceInboundService } = await import('../commerce/services/commerceInboundService.js');
const { consentService } = await import('../commerce/services/consentService.js');
const { findOptinToken } = await import('../commerce/services/optinLinkService.js');

const app = express();
// Mounted BEFORE express.json(), exactly as in app.ts: the signature is over raw bytes, and a body
// parser that reserializes them would make every valid signature fail.
app.use('/webhooks/meta', metaWebhookRoutes);
app.use(express.json());
app.use('/orgs', orgRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

interface TestUser {
  readonly id: string;
  readonly auth: string;
}

async function createUser(): Promise<TestUser> {
  const row = await db
    .insertInto('users')
    .values({
      email: `commerce-optin-${randomUUID()}@stewra.invalid`,
      display_name: 'Opt-in Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  const auth = `Bearer ${jwt.sign({ sub: row.id, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
  return { id: row.id, auth };
}

interface Tenant {
  readonly owner: TestUser;
  readonly orgId: string;
  readonly wabaId: string;
  readonly accountId: string;
  readonly phone: string;
}

/**
 * An organization with one connected number.
 *
 * `display_phone_number` is set here because a link cannot be minted without it — that is the
 * refusal proven separately below, using an account deliberately left without one.
 */
async function createTenant(phone = '+1 555 010 0200'): Promise<Tenant> {
  const owner = await createUser();
  const { org } = await organizationRepository.create({
    name: 'Opt-in Co',
    slug: `optin-${randomUUID().slice(0, 8)}`,
    createdBy: owner.id,
  });
  createdOrgs.push(org.id);

  const wabaId = `1${Math.floor(Math.random() * 1_000_000_000_000_000)}`;
  const account = await db
    .insertInto('channel_accounts')
    .values({
      org_id: org.id,
      platform: 'whatsapp_cloud',
      external_account_id: wabaId,
      phone_number_id: `p-${randomUUID().slice(0, 8)}`,
      display_name: phone,
      display_phone_number: phone,
      credential_ref: randomUUID(),
      meta: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { owner, orgId: org.id, wabaId, accountId: account.id, phone };
}

async function addMember(orgId: string, role: 'admin' | 'agent' | 'viewer'): Promise<TestUser> {
  const user = await createUser();
  await db.insertInto('org_members').values({ org_id: orgId, user_id: user.id, role }).execute();
  return user;
}

/** Mint a link over the real route, with sensible defaults each test can override. */
async function mint(
  tenant: Tenant,
  overrides: Partial<{
    auth: string;
    channelAccountId: string;
    name: string;
    purpose: 'service' | 'marketing';
    phrase: string;
  }> = {},
): Promise<request.Response> {
  return request(API)
    .post(`/orgs/${tenant.orgId}/optin-links`)
    .set('Authorization', overrides.auth ?? tenant.owner.auth)
    .send({
      channelAccountId: overrides.channelAccountId ?? tenant.accountId,
      name: overrides.name ?? `Link ${randomUUID().slice(0, 8)}`,
      purpose: overrides.purpose ?? 'marketing',
      phrase: overrides.phrase ?? 'Yes, please send me offers',
    });
}

/** Meta's envelope for one inbound text, optionally carrying a click-to-WhatsApp referral. */
function envelope(params: {
  wabaId: string;
  from: string;
  text: string;
  messageId?: string;
  referral?: Record<string, string>;
}): unknown {
  return {
    id: params.wabaId,
    changes: [
      {
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          contacts: [{ wa_id: params.from, profile: { name: 'A Customer' } }],
          messages: [
            {
              id: params.messageId ?? `wamid.${randomUUID()}`,
              from: params.from,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'text',
              text: { body: params.text },
              ...(params.referral === undefined ? {} : { referral: params.referral }),
            },
          ],
        },
      },
    ],
  };
}

/**
 * Push one message through the REAL adapter and the REAL inbound service, and await it.
 *
 * The HTTP endpoint dispatches without awaiting — it must, because Meta retries anything it does not
 * see a fast 200 for — so driving the service directly is what makes these assertions deterministic
 * rather than racing a background promise. The HTTP path itself is covered separately, once, below.
 */
async function deliver(params: {
  wabaId: string;
  from: string;
  text: string;
  messageId?: string;
  referral?: Record<string, string>;
}): Promise<void> {
  const messages = whatsappInboundAdapter.normalize(envelope(params));
  expect(messages).toHaveLength(1);
  const message = messages[0];
  if (message === undefined) throw new Error('adapter yielded nothing');
  await commerceInboundService.handle(message);
}

/** Every consent row for one org's contact, newest first. */
async function consentsFor(
  orgId: string,
  externalId: string,
): Promise<
  {
    purpose: string;
    state: string;
    source: string;
    evidence: string;
    optin_link_id: string | null;
    recorded_by_user_id: string | null;
  }[]
> {
  return db
    .selectFrom('commerce_contact_consents as c')
    .innerJoin('commerce_contacts as ct', 'ct.id', 'c.contact_id')
    .select([
      'c.purpose',
      'c.state',
      'c.source',
      'c.evidence',
      'c.optin_link_id',
      'c.recorded_by_user_id',
    ])
    .where('c.org_id', '=', orgId)
    .where('ct.external_id', '=', externalId)
    .orderBy('c.recorded_at', 'desc')
    .execute();
}

async function contactIdFor(orgId: string, externalId: string): Promise<string> {
  const row = await db
    .selectFrom('commerce_contacts')
    .select('id')
    .where('org_id', '=', orgId)
    .where('external_id', '=', externalId)
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A tenant that may actually send marketing: quiet hours set and lawful opt-in attested. */
async function makeSendable(tenant: Tenant): Promise<void> {
  await consentService.setQuietHours({
    orgId: tenant.orgId,
    timezone: 'UTC',
    quietHoursStart: '00:00',
    quietHoursEnd: '00:00',
  });
  await consentService.attest({
    orgId: tenant.orgId,
    attestedByUserId: tenant.owner.id,
    attestationText: 'We hold lawful opt-in.',
  });
}

let phoneCounter = Math.floor(Math.random() * 5_000_000);
function customerNumber(): string {
  phoneCounter += 1;
  return `4477${String(10_000_000 + phoneCounter).slice(0, 8)}`;
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    // The consent table is append-only by trigger, so the guard is lifted for teardown exactly as
    // the sibling suites do. Nothing in the suite ever updates a consent row through the app.
    await sql`ALTER TABLE commerce_contact_consents DISABLE TRIGGER trg_commerce_consents_append_only`.execute(
      db,
    );
    await db.deleteFrom('commerce_contact_consents').where('org_id', 'in', createdOrgs).execute();
    await sql`ALTER TABLE commerce_contact_consents ENABLE TRIGGER trg_commerce_consents_append_only`.execute(
      db,
    );
    await db.deleteFrom('commerce_optin_links').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_suppressions').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_messages').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_conversations').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_contacts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_messaging_policies').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('channel_accounts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_active_orgs').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdUsers.length > 0) {
    await db
      .deleteFrom('users')
      .where('id', 'in', createdUsers)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id'),
          ),
        ),
      )
      .execute();
  }
  await database.closeDb();
});

// ---------------------------------------------------------------------------------------------
// Minting a link
// ---------------------------------------------------------------------------------------------

describe('minting an opt-in link', () => {
  it('returns a wa.me URL that opens the right number with the sentence already written', async () => {
    const tenant = await createTenant('+1 555 010 0201');
    const res = await mint(tenant, { phrase: 'Yes, send me offers' });

    expect(res.status).toBe(201);
    const link = res.body.data.link;
    // The number with separators stripped — `wa.me` accepts digits only, and the account stored it
    // in Meta's spaced display form.
    expect(link.url).toContain('https://wa.me/15550100201?text=');
    expect(decodeURIComponent(link.url.split('?text=')[1])).toBe(link.prefillText);
    expect(link.prefillText.startsWith('Yes, send me offers ')).toBe(true);
    expect(link.optInCount).toBe(0);
    expect(link.status).toBe('active');
  });

  it('appends a reference code the customer will carry back, which the caller never supplies', async () => {
    const tenant = await createTenant();
    const res = await mint(tenant, { phrase: 'Yes please' });

    const link = res.body.data.link;
    expect(findOptinToken(link.prefillText)).toBe(link.token);
    // The token is what makes the sentence traceable; without it the message is indistinguishable
    // from any other customer writing the same words.
    expect(link.prefillText).toBe(`Yes please [${link.token}]`);
  });

  it('gives two links different tokens, so a complaint names exactly one of them', async () => {
    const tenant = await createTenant();
    const first = await mint(tenant, { name: 'Receipt QR' });
    const second = await mint(tenant, { name: 'Website footer' });

    expect(first.body.data.link.token).not.toBe(second.body.data.link.token);
  });

  it('refuses a second link with the same name', async () => {
    const tenant = await createTenant();
    await mint(tenant, { name: 'Receipt QR' });
    const res = await mint(tenant, { name: 'Receipt QR' });

    expect(res.status).toBe(409);
  });

  it('refuses a phrase that already contains a bracketed code', async () => {
    // Otherwise the message would carry two candidate tokens and the matcher would take the first,
    // which is how someone could get a customer to opt in to a link nobody at that business minted.
    const tenant = await createTenant();
    const res = await mint(tenant, { phrase: 'Yes [AAAAAAAAAAAA] please' });

    expect(res.status).toBe(400);
  });

  it('refuses to build a link for a number Meta never gave us, rather than guessing one', async () => {
    const tenant = await createTenant();
    // A channel connected before the number was captured, or one Meta reported without a number.
    await db
      .updateTable('channel_accounts')
      .set({ display_phone_number: null, display_name: 'Acme Trading Ltd' })
      .where('id', '=', tenant.accountId)
      .execute();

    const res = await mint(tenant);

    expect(res.status).toBe(400);
    // The fallback name has digits in it nowhere, but the point is that it must not be parsed at
    // all: a link built from a business name would open a chat with a stranger.
    expect(JSON.stringify(res.body)).toContain('Reconnect the channel');
  });

  it('refuses a channel belonging to another organization', async () => {
    const tenant = await createTenant();
    const other = await createTenant();
    const res = await mint(tenant, { channelAccountId: other.accountId });

    expect(res.status).toBe(404);
  });

  it('lets an agent read the links but not mint one', async () => {
    const tenant = await createTenant();
    await mint(tenant, { name: 'Receipt QR' });
    const agent = await addMember(tenant.orgId, 'agent');

    const listed = await request(API)
      .get(`/orgs/${tenant.orgId}/optin-links`)
      .set('Authorization', agent.auth);
    expect(listed.status).toBe(200);
    expect(listed.body.data.links).toHaveLength(1);

    const minted = await mint(tenant, { auth: agent.auth });
    expect(minted.status).toBe(403);
  });

  it('does not show one organization another organization links', async () => {
    const tenant = await createTenant();
    await mint(tenant, { name: 'Receipt QR' });
    const other = await createTenant();

    const res = await request(API)
      .get(`/orgs/${other.orgId}/optin-links`)
      .set('Authorization', other.owner.auth);
    expect(res.body.data.links).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// A customer arriving through a link
// ---------------------------------------------------------------------------------------------

describe('a customer who sends the link message', () => {
  it('is recorded as opted in to marketing, in their own words, by nobody', async () => {
    const tenant = await createTenant();
    const link = (await mint(tenant, { purpose: 'marketing' })).body.data.link;
    const from = customerNumber();

    await deliver({ wabaId: tenant.wabaId, from, text: link.prefillText });

    const consents = await consentsFor(tenant.orgId, from);
    expect(consents).toHaveLength(1);
    expect(consents[0]?.purpose).toBe('marketing');
    expect(consents[0]?.state).toBe('opted_in');
    // `inbound_message`, not `web_form`: the message IS the evidence, and it can be re-read on the
    // platform rather than taken on our word.
    expect(consents[0]?.source).toBe('inbound_message');
    expect(consents[0]?.optin_link_id).toBe(link.id);
    // Nobody recorded this. It happened.
    expect(consents[0]?.recorded_by_user_id).toBeNull();
  });

  it('becomes someone a campaign is actually allowed to reach', async () => {
    // The consent row is only interesting if the send gate agrees with it. This is the assertion
    // that ties the feature to the thing it exists for.
    const tenant = await createTenant();
    await makeSendable(tenant);
    const link = (await mint(tenant, { purpose: 'marketing' })).body.data.link;
    const from = customerNumber();

    await deliver({ wabaId: tenant.wabaId, from, text: link.prefillText });

    await expect(
      consentService.assertMaySend({
        orgId: tenant.orgId,
        contactId: await contactIdFor(tenant.orgId, from),
        platform: 'whatsapp_cloud',
        externalId: from,
        purpose: 'marketing',
      }),
    ).resolves.toBeUndefined();
  });

  it('grants only service permission when that is what the link declared', async () => {
    const tenant = await createTenant();
    await makeSendable(tenant);
    const link = (await mint(tenant, { purpose: 'service' })).body.data.link;
    const from = customerNumber();

    await deliver({ wabaId: tenant.wabaId, from, text: link.prefillText });

    const consents = await consentsFor(tenant.orgId, from);
    expect(consents[0]?.purpose).toBe('service');
    // A support link must not quietly build a marketing list.
    await expect(
      consentService.assertMaySend({
        orgId: tenant.orgId,
        contactId: await contactIdFor(tenant.orgId, from),
        platform: 'whatsapp_cloud',
        externalId: from,
        purpose: 'marketing',
      }),
    ).rejects.toThrow(/no marketing consent/i);
  });

  it('counts the opt-ins it gathered, which is the only feedback a printed sticker gives', async () => {
    const tenant = await createTenant();
    const link = (await mint(tenant)).body.data.link;

    await deliver({ wabaId: tenant.wabaId, from: customerNumber(), text: link.prefillText });
    await deliver({ wabaId: tenant.wabaId, from: customerNumber(), text: link.prefillText });

    const res = await request(API)
      .get(`/orgs/${tenant.orgId}/optin-links`)
      .set('Authorization', tenant.owner.auth);
    expect(res.body.data.links[0].optInCount).toBe(2);
  });

  it('records nothing for a retired link, and leaves the message an ordinary one', async () => {
    // The sentence stays on packaging long after a business stops honouring it. Silently recording
    // a permission it has decided not to collect is worse than recording nothing.
    const tenant = await createTenant();
    const link = (await mint(tenant)).body.data.link;
    await request(API)
      .post(`/orgs/${tenant.orgId}/optin-links/${link.id}/disable`)
      .set('Authorization', tenant.owner.auth);
    const from = customerNumber();

    await deliver({ wabaId: tenant.wabaId, from, text: link.prefillText });

    expect(await consentsFor(tenant.orgId, from)).toHaveLength(0);
    // The message still lands — the customer wrote to a business and must appear in its inbox.
    const messages = await db
      .selectFrom('commerce_messages')
      .select('body')
      .where('org_id', '=', tenant.orgId)
      .execute();
    expect(messages).toHaveLength(1);
  });

  it('keeps the opt-ins a retired link already gathered, and keeps them attributed to it', async () => {
    const tenant = await createTenant();
    const link = (await mint(tenant)).body.data.link;
    const from = customerNumber();
    await deliver({ wabaId: tenant.wabaId, from, text: link.prefillText });

    const res = await request(API)
      .post(`/orgs/${tenant.orgId}/optin-links/${link.id}/disable`)
      .set('Authorization', tenant.owner.auth);

    expect(res.body.data.link.status).toBe('disabled');
    expect(res.body.data.link.optInCount).toBe(1);
    expect((await consentsFor(tenant.orgId, from))[0]?.optin_link_id).toBe(link.id);
  });

  it('ignores a token minted by a different organization', async () => {
    // Someone who saw one business's sticker cannot consent on behalf of another, and a token that
    // resolved across the tenant boundary would let them.
    const tenant = await createTenant();
    const other = await createTenant();
    const foreign = (await mint(other)).body.data.link;
    const from = customerNumber();

    await deliver({ wabaId: tenant.wabaId, from, text: foreign.prefillText });

    expect(await consentsFor(tenant.orgId, from)).toHaveLength(0);
    expect(await consentsFor(other.orgId, from)).toHaveLength(0);
  });

  it('treats an edited-down "stop" as the opt-out it plainly is, not as an opt-in', async () => {
    // The phrase is fixed when the link is minted, but nothing stops a customer clearing the box and
    // typing one word. Whichever half of the message we honour, it must be the one they meant.
    const tenant = await createTenant();
    await mint(tenant, { purpose: 'marketing' });
    const from = customerNumber();

    await deliver({ wabaId: tenant.wabaId, from, text: 'stop' });

    const consents = await consentsFor(tenant.orgId, from);
    expect(consents).toHaveLength(1);
    expect(consents[0]?.state).toBe('opted_out');
    expect(consents[0]?.source).toBe('keyword');
  });

  it('lifts an earlier opt-out when they deliberately opt in again', async () => {
    const tenant = await createTenant();
    const link = (await mint(tenant, { purpose: 'marketing' })).body.data.link;
    const from = customerNumber();
    await deliver({ wabaId: tenant.wabaId, from, text: 'stop' });

    await deliver({ wabaId: tenant.wabaId, from, text: link.prefillText });

    // Consent alone would be decorative while the suppression still blocks every send.
    const suppression = await db
      .selectFrom('commerce_suppressions')
      .selectAll()
      .where('org_id', '=', tenant.orgId)
      .where('external_id', '=', from)
      .executeTakeFirst();
    expect(suppression).toBeUndefined();
  });

  it('does NOT lift a complaint, which is not the customer\'s to undo by sending a phrase', async () => {
    const tenant = await createTenant();
    const link = (await mint(tenant, { purpose: 'marketing' })).body.data.link;
    const from = customerNumber();
    await deliver({ wabaId: tenant.wabaId, from, text: 'hello' });
    await consentService.suppress({
      orgId: tenant.orgId,
      platform: 'whatsapp_cloud',
      externalId: from,
      reason: 'complaint',
      detail: 'Reported to the regulator',
    });

    await deliver({ wabaId: tenant.wabaId, from, text: link.prefillText });

    const suppression = await db
      .selectFrom('commerce_suppressions')
      .select('reason')
      .where('org_id', '=', tenant.orgId)
      .where('external_id', '=', from)
      .executeTakeFirst();
    expect(suppression?.reason).toBe('complaint');
  });
});

// ---------------------------------------------------------------------------------------------
// A customer arriving from an ad
// ---------------------------------------------------------------------------------------------

describe('a customer who arrives from a click-to-WhatsApp ad', () => {
  const REFERRAL = {
    source_type: 'ad',
    source_id: '120200000000000001',
    source_url: 'https://fb.me/spring-sale',
    headline: 'Spring sale — message us',
    ctwa_clid: 'ARBcLICKid0123456789',
  };

  it('is recorded as SERVICE, never marketing, however the ad was worded', async () => {
    // The load-bearing test of this file. Tapping "Message us" agrees to a conversation; it does not
    // subscribe anyone to a campaign. Promoting it would build the exact list this regime refuses,
    // and every step of that promotion would look locally reasonable.
    const tenant = await createTenant();
    const from = customerNumber();

    await deliver({ wabaId: tenant.wabaId, from, text: 'Hi, is this in stock?', referral: REFERRAL });

    const consents = await consentsFor(tenant.orgId, from);
    expect(consents).toHaveLength(1);
    expect(consents[0]?.purpose).toBe('service');
    expect(consents[0]?.source).toBe('ad_click');
    expect(consents[0]?.optin_link_id).toBeNull();
  });

  it('still cannot be sent a campaign', async () => {
    const tenant = await createTenant();
    await makeSendable(tenant);
    const from = customerNumber();

    await deliver({ wabaId: tenant.wabaId, from, text: 'Hi', referral: REFERRAL });

    await expect(
      consentService.assertMaySend({
        orgId: tenant.orgId,
        contactId: await contactIdFor(tenant.orgId, from),
        platform: 'whatsapp_cloud',
        externalId: from,
        purpose: 'marketing',
      }),
    ).rejects.toThrow(/no marketing consent/i);
  });

  it('keeps the click id, which exists on this one message and cannot be recovered later', async () => {
    const tenant = await createTenant();
    const from = customerNumber();

    await deliver({ wabaId: tenant.wabaId, from, text: 'Hi', referral: REFERRAL });

    const evidence = (await consentsFor(tenant.orgId, from))[0]?.evidence ?? '';
    expect(evidence).toContain(REFERRAL.ctwa_clid);
    expect(evidence).toContain(REFERRAL.source_id);
    expect(evidence).toContain(REFERRAL.headline);
  });

  it('records only the parts Meta actually sent', async () => {
    // A blank in a proof field reads as a value that was lost rather than one that never existed.
    const tenant = await createTenant();
    const from = customerNumber();

    await deliver({
      wabaId: tenant.wabaId,
      from,
      text: 'Hi',
      referral: { source_type: 'post', source_id: '99887766' },
    });

    const evidence = (await consentsFor(tenant.orgId, from))[0]?.evidence ?? '';
    expect(evidence).toContain('post entry point');
    expect(evidence).toContain('99887766');
    expect(evidence).not.toContain('undefined');
    expect(evidence).not.toContain('null');
  });

  it('lets the link win when a message carries both, because it is the stronger evidence', async () => {
    const tenant = await createTenant();
    const link = (await mint(tenant, { purpose: 'marketing' })).body.data.link;
    const from = customerNumber();

    await deliver({
      wabaId: tenant.wabaId,
      from,
      text: link.prefillText,
      referral: REFERRAL,
    });

    const consents = await consentsFor(tenant.orgId, from);
    expect(consents).toHaveLength(1);
    expect(consents[0]?.source).toBe('inbound_message');
    expect(consents[0]?.purpose).toBe('marketing');
  });

  it('records nothing at all for an ordinary message with neither', async () => {
    const tenant = await createTenant();
    const from = customerNumber();

    await deliver({ wabaId: tenant.wabaId, from, text: 'do you open on Sundays?' });

    expect(await consentsFor(tenant.orgId, from)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The real HTTP path, once, end to end
// ---------------------------------------------------------------------------------------------

describe('the signed webhook', () => {
  it('carries a link opt-in all the way from Meta bytes to a consent row', async () => {
    const tenant = await createTenant();
    const link = (await mint(tenant, { purpose: 'marketing' })).body.data.link;
    const from = customerNumber();
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [envelope({ wabaId: tenant.wabaId, from, text: link.prefillText })],
    });

    const res = await request(API)
      .post('/webhooks/meta')
      .set('Content-Type', 'application/json')
      .set(
        'x-hub-signature-256',
        `sha256=${createHmac('sha256', APP_HMAC).update(Buffer.from(body)).digest('hex')}`,
      )
      .send(body);
    expect(res.status).toBe(200);

    // The endpoint answers before the work is done — it must, or Meta retries for a week — so the
    // row is waited for rather than assumed present the instant the response lands.
    let consents = await consentsFor(tenant.orgId, from);
    for (let attempt = 0; attempt < 50 && consents.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      consents = await consentsFor(tenant.orgId, from);
    }

    expect(consents).toHaveLength(1);
    expect(consents[0]?.optin_link_id).toBe(link.id);
  });
});
