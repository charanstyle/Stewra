import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import request from 'supertest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';

/**
 * The MULTI-TENANT inbound path: one webhook URL, every organization's traffic.
 *
 * This is the suite that has to hold, because the failure it guards against is not a crash. If
 * routing picks the wrong tenant — or picks one at all when it should not — a business sees a
 * stranger's customers in its inbox and nothing anywhere reports an error. So the assertions here
 * are about ROWS, in a real Postgres, reached through real HTTP with a real HMAC.
 *
 * Nothing is mocked. Real `unifiedConfig` parsing real environment (including its own
 * META_COMMERCE_ENABLED guard), real `express.raw()`, real signature middleware, real router, real
 * error handler, real `stewra_test` database. A stubbed signature check would let a signature bug
 * pass this file and open the endpoint in production.
 */

// Generated, never hardcoded: a literal would be a committed credential, and generating it also
// proves the config pipeline plumbs through whatever value it is handed rather than a baked-in one.
const APP_HMAC = randomBytes(32).toString('hex');
const HANDSHAKE = `verify-${randomBytes(8).toString('hex')}`;

process.env['META_COMMERCE_ENABLED'] = 'true';
process.env['META_COMMERCE_APP_ID'] = '100000000000001';
process.env['META_COMMERCE_APP_SECRET'] = APP_HMAC;
process.env['META_COMMERCE_CONFIG_ID'] = '200000000000002';
process.env['META_COMMERCE_VERIFY_TOKEN'] = HANDSHAKE;

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

const app = express();
app.use('/webhooks/meta', metaWebhookRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

/** The HMAC Meta would attach to exactly these bytes. */
function signature(body: string, signingWith: string = APP_HMAC): string {
  return `sha256=${createHmac('sha256', signingWith).update(Buffer.from(body)).digest('hex')}`;
}

/** Meta's envelope for one text message, as it really arrives. */
function inboundEnvelope(params: {
  wabaId: string;
  from: string;
  text: string;
  messageId: string;
  profileName?: string;
}): string {
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
              contacts: [
                { wa_id: params.from, profile: { name: params.profileName ?? 'A Customer' } },
              ],
              messages: [
                {
                  id: params.messageId,
                  from: params.from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
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

async function post(body: string, sig: string = signature(body)): Promise<number> {
  const res = await request(API)
    .post('/webhooks/meta')
    .set('Content-Type', 'application/json')
    .set('x-hub-signature-256', sig)
    .send(body);
  return res.status;
}

/** An organization with one connected WhatsApp account. Returns the org id and its WABA id. */
async function orgWithChannel(): Promise<{ orgId: string; wabaId: string; accountId: string }> {
  const user = await db
    .insertInto('users')
    .values({
      email: `commerce-webhook-${randomUUID()}@stewra.invalid`,
      display_name: 'Commerce Webhook Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(user.id);

  const { org } = await organizationRepository.create({
    name: 'Webhook Test Co',
    slug: `webhook-${randomUUID().slice(0, 8)}`,
    createdBy: user.id,
  });
  createdOrgs.push(org.id);

  // A distinct WABA id per org — that id is the ONLY thing routing has to go on.
  const wabaId = `1${Math.floor(Math.random() * 1_000_000_000_000_000)}`;
  const account = await db
    .insertInto('channel_accounts')
    .values({
      org_id: org.id,
      platform: 'whatsapp_cloud',
      external_account_id: wabaId,
      phone_number_id: `p-${randomUUID().slice(0, 8)}`,
      display_name: '+1 555 000 0000',
      // No vault round-trip needed: nothing in the inbound path reads the credential.
      credential_ref: randomUUID(),
      meta: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { orgId: org.id, wabaId, accountId: account.id };
}

/** Every message row in an organization's inbox, oldest first. */
async function messagesFor(orgId: string): Promise<{ body: string; direction: string }[]> {
  return db
    .selectFrom('commerce_messages')
    .select(['body', 'direction'])
    .where('org_id', '=', orgId)
    .orderBy('created_at', 'asc')
    .execute();
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    await db.deleteFrom('commerce_messages').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_conversations').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_contacts').where('org_id', 'in', createdOrgs).execute();
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
        not(exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id'))),
      )
      .execute();
  }
  await database.closeDb();
});

// ---------------------------------------------------------------------------------------------
// The signature is the only door
// ---------------------------------------------------------------------------------------------

describe('POST /webhooks/meta signature gate', () => {
  it('accepts a correctly signed payload', async () => {
    const { wabaId } = await orgWithChannel();
    const body = inboundEnvelope({
      wabaId,
      from: '15550001111',
      text: 'hello',
      messageId: `wamid.${randomUUID()}`,
    });
    expect(await post(body)).toBe(200);
  });

  it('rejects a payload signed with the wrong secret', async () => {
    const { wabaId } = await orgWithChannel();
    const body = inboundEnvelope({
      wabaId,
      from: '15550001111',
      text: 'forged',
      messageId: `wamid.${randomUUID()}`,
    });
    const otherSecret = randomBytes(32).toString('hex');
    expect(await post(body, signature(body, otherSecret))).toBe(401);
  });

  it('rejects a missing or malformed signature header rather than crashing on it', async () => {
    const body = inboundEnvelope({
      wabaId: '1234',
      from: '15550001111',
      text: 'x',
      messageId: `wamid.${randomUUID()}`,
    });
    const noHeader = await request(API)
      .post('/webhooks/meta')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(noHeader.status).toBe(401);
    expect(await post(body, 'not-even-a-prefix')).toBe(401);
  });

  it('rejects a body altered after signing — the signature covers the exact bytes', async () => {
    const { wabaId } = await orgWithChannel();
    const original = inboundEnvelope({
      wabaId,
      from: '15550001111',
      text: 'original',
      messageId: `wamid.${randomUUID()}`,
    });
    const tampered = original.replace('original', 'tampered');
    expect(await post(tampered, signature(original))).toBe(401);
  });

  it('fails LOUD (not silently open) when the router is mounted after express.json()', async () => {
    // The misordering that would otherwise leave this endpoint authenticating nothing: with the body
    // already parsed, the raw bytes are gone and the HMAC cannot be computed. It must throw, not pass.
    const misordered = express();
    misordered.use(express.json());
    misordered.use('/webhooks/meta', metaWebhookRoutes);
    misordered.use(errorHandler);
    const listener = misordered.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

    const body = inboundEnvelope({
      wabaId: '1234',
      from: '15550001111',
      text: 'x',
      messageId: `wamid.${randomUUID()}`,
    });
    const res = await request(url)
      .post('/webhooks/meta')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature(body))
      .send(body);
    expect(res.status).toBe(500);

    await new Promise<void>((resolve) => listener.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------------------------
// Routing: one URL, many tenants
// ---------------------------------------------------------------------------------------------

describe('routing an inbound message to the organization that owns the account', () => {
  it('lands the message in that org, and in no other', async () => {
    const a = await orgWithChannel();
    const b = await orgWithChannel();

    await deliver({
      wabaId: a.wabaId,
      from: '15550002222',
      text: 'do you deliver on sundays?',
      profileName: 'Dana',
    });

    const inA = await messagesFor(a.orgId);
    expect(inA).toHaveLength(1);
    expect(inA[0]?.body).toBe('do you deliver on sundays?');
    expect(inA[0]?.direction).toBe('inbound');

    // The whole point. B is a real, connected tenant on the same endpoint and must see nothing.
    expect(await messagesFor(b.orgId)).toHaveLength(0);
  });

  it('records the contact against the receiving org, with the profile name and E.164 number', async () => {
    const { orgId, wabaId } = await orgWithChannel();
    await deliver({ wabaId, from: '447700900123', text: 'hi', profileName: 'Sam' });

    const contact = await db
      .selectFrom('commerce_contacts')
      .select(['display_name', 'phone_e164', 'external_id'])
      .where('org_id', '=', orgId)
      .executeTakeFirstOrThrow();
    expect(contact.display_name).toBe('Sam');
    expect(contact.external_id).toBe('447700900123');
    // wa_id is E.164 without the '+'. Restoring it is a format change, not an invented value.
    expect(contact.phone_e164).toBe('+447700900123');
  });

  it('opens a 24-hour service window from the customer’s own timestamp', async () => {
    const { orgId, wabaId } = await orgWithChannel();
    await deliver({ wabaId, from: '15550003333', text: 'hello' });

    const row = await db
      .selectFrom('commerce_conversations')
      .select(['last_message_at', 'service_window_expires_at'])
      .where('org_id', '=', orgId)
      .executeTakeFirstOrThrow();
    expect(row.service_window_expires_at).not.toBeNull();
    expect(row.last_message_at).not.toBeNull();
    const gap =
      (row.service_window_expires_at?.getTime() ?? 0) - (row.last_message_at?.getTime() ?? 0);
    expect(gap).toBe(24 * 60 * 60 * 1000);
  });

  it('DROPS a message for a WABA nobody has connected — never guesses a tenant', async () => {
    const existing = await orgWithChannel();
    const unknownWaba = `1${Math.floor(Math.random() * 1_000_000_000_000_000)}`;

    // Still a 200: the payload is authentically Meta's, and anything else earns a week of retries.
    expect(
      await post(
        inboundEnvelope({
          wabaId: unknownWaba,
          from: '15550004444',
          text: 'who am I talking to?',
          messageId: `wamid.${randomUUID()}`,
        }),
      ),
    ).toBe(200);

    // A second, KNOWN-GOOD delivery to a different contact, waited for. The drop path is strictly
    // shorter than the one just awaited — one lookup, then return — so by the time this has landed,
    // the dropped message has certainly finished. That is what makes the absence below meaningful
    // rather than a race that happened to be won.
    await deliver({ wabaId: existing.wabaId, from: '15550009999', text: 'a real customer' });

    // The tenant that DOES exist must not have inherited the orphan.
    const inExisting = await messagesFor(existing.orgId);
    expect(inExisting).toHaveLength(1);
    expect(inExisting[0]?.body).toBe('a real customer');

    const anyContact = await db
      .selectFrom('commerce_contacts')
      .select('id')
      .where('external_id', '=', '15550004444')
      .executeTakeFirst();
    expect(anyContact).toBeUndefined();
  });

  it('deduplicates a redelivered message — Meta retries for seven days', async () => {
    const { orgId, wabaId } = await orgWithChannel();
    const messageId = `wamid.${randomUUID()}`;
    const body = inboundEnvelope({
      wabaId,
      from: '15550005555',
      text: 'same message twice',
      messageId,
    });

    expect(await post(body)).toBe(200);
    await waitForMessage(messageId);
    expect(await post(body)).toBe(200);

    // The redelivery is deduped before it writes anything, so there is no new row to wait for. A
    // known-good delivery afterwards gives a deterministic point at which the duplicate is finished.
    await deliver({ wabaId, from: '15550007777', text: 'someone else' });

    expect(await messagesFor(orgId)).toHaveLength(2);
    const bodies = (await messagesFor(orgId)).map((m) => m.body);
    expect(bodies.filter((b) => b === 'same message twice')).toHaveLength(1);
  });

  it('keeps one thread per contact across several messages', async () => {
    const { orgId, wabaId } = await orgWithChannel();
    for (const text of ['first', 'second', 'third']) {
      await deliver({ wabaId, from: '15550006666', text });
    }

    expect(await messagesFor(orgId)).toHaveLength(3);
    const threads = await db
      .selectFrom('commerce_conversations')
      .select('id')
      .where('org_id', '=', orgId)
      .execute();
    expect(threads).toHaveLength(1);
  });

  it('ignores a status/receipt callback on the same subscription without writing anything', async () => {
    const { orgId, wabaId } = await orgWithChannel();
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                statuses: [{ id: `wamid.${randomUUID()}`, status: 'delivered' }],
              },
            },
          ],
        },
      ],
    });
    expect(await post(body)).toBe(200);

    // Same trick as the dropped-WABA case: a known-good delivery afterwards is the deterministic
    // point at which the receipt has certainly finished doing nothing.
    await deliver({ wabaId, from: '15550008888', text: 'an actual message' });
    const rows = await messagesFor(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('an actual message');
  });

  it('acks an envelope for a product we have no adapter for, instead of retrying forever', async () => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: 'ig-1', messaging: [] }] });
    expect(await post(body)).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// The subscription handshake
// ---------------------------------------------------------------------------------------------

describe('GET /webhooks/meta handshake', () => {
  it('echoes the challenge as plain text when the verify token matches', async () => {
    const res = await request(API).get('/webhooks/meta').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': HANDSHAKE,
      'hub.challenge': 'challenge-value',
    });
    expect(res.status).toBe(200);
    // Plain text, not wrapped in our JSON envelope — Meta rejects the endpoint otherwise.
    expect(res.text).toBe('challenge-value');
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('refuses a wrong verify token, and refuses a mode that is not subscribe', async () => {
    const wrongToken = await request(API).get('/webhooks/meta').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': `${HANDSHAKE}-wrong`,
      'hub.challenge': 'challenge-value',
    });
    expect(wrongToken.status).toBe(403);

    const wrongMode = await request(API).get('/webhooks/meta').query({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': HANDSHAKE,
      'hub.challenge': 'challenge-value',
    });
    expect(wrongMode.status).toBe(403);
  });
});

/**
 * The controller 200s BEFORE it writes, on purpose (Meta retries anything slower), so a test that
 * asserts on rows has to wait for the dispatch it deliberately did not wait for.
 *
 * Polling for the specific row rather than sleeping a guessed interval: a fixed sleep is a flaky test
 * waiting to happen on a slower machine, and — worse — a sleep that is too short makes an assertion
 * about ABSENCE pass for the wrong reason.
 */
async function waitForMessage(providerMessageId: string): Promise<void> {
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

/** Post a well-formed inbound message and wait for it to be written. Returns nothing on purpose. */
async function deliver(params: {
  wabaId: string;
  from: string;
  text: string;
  profileName?: string;
}): Promise<string> {
  const messageId = `wamid.${randomUUID()}`;
  const body = inboundEnvelope({ ...params, messageId });
  expect(await post(body)).toBe(200);
  await waitForMessage(messageId);
  return messageId;
}
