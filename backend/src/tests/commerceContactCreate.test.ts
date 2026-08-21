import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { sql } from 'kysely';
import { config } from '../config/unifiedConfig.js';
import { db, closeDb } from '../database/index.js';
import { errorHandler } from '../middleware/errorHandler.js';
import orgRoutes from '../tenancy/routes/organizations.js';
import commerceOrgRoutes from '../commerce/routes/orgSurface.js';
import { organizationRepository } from '../tenancy/repositories/organizationRepository.js';
import { commerceInboxRepository } from '../commerce/repositories/commerceInboxRepository.js';
import { normalizeE164 } from '../commerce/services/callingCodes.js';

/**
 * ADDING A CONTACT — the door that did not exist.
 *
 * Until `POST /orgs/:orgId/contacts`, a contact could only come into being by messaging the business
 * first. A tenant with a perfectly lawful opt-in list had nothing to load it into, which made the
 * whole commerce plane unusable on day one.
 *
 * The properties defended here are the ones that make a NEW door safe rather than merely present:
 *
 *   - a contact created by hand and the same person arriving later over the webhook are ONE row, so
 *     their consent history cannot be split across two identities;
 *   - consent, when supplied, goes through the same append-only `consentService` path the inbound
 *     keyword handler uses, and when NOT supplied its absence refuses marketing rather than
 *     defaulting to permitted;
 *   - a number with no country code is refused, never guessed — a guess does not fail, it silently
 *     addresses a stranger.
 *
 * Real Postgres, the real router, the real requireAuth → requireEmailVerification → requireOrgMember
 * chain over real HTTP. The middleware IS the boundary, so calling the controller directly would
 * assert nothing about the door being shut.
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

interface TestUser {
  readonly id: string;
  readonly auth: string;
}

async function createUser(): Promise<TestUser> {
  const row = await db
    .insertInto('users')
    .values({
      email: `commerce-contact-create-${randomUUID()}@stewra.invalid`,
      display_name: 'Contact Create Test User',
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
}

async function createTenant(): Promise<Tenant> {
  const owner = await createUser();
  const { org } = await organizationRepository.create({
    kind: 'business',
    name: 'Contact Create Co',
    slug: `contacts-${randomUUID().slice(0, 8)}`,
    createdBy: owner.id,
  });
  createdOrgs.push(org.id);
  return { owner, orgId: org.id };
}

/** Put an existing user into an org at a given role, bypassing the invite dance. */
async function addMember(orgId: string, role: 'admin' | 'agent' | 'viewer'): Promise<TestUser> {
  const user = await createUser();
  await db.insertInto('org_members').values({ org_id: orgId, user_id: user.id, role }).execute();
  return user;
}

/** A distinct, well-formed UK mobile per call, so tests cannot collide on the unique index. */
function uniquePhone(): string {
  return `+4477${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    await db.deleteFrom('commerce_contact_tags').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_tags').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_suppressions').where('org_id', 'in', createdOrgs).execute();
    await dropConsentRows(createdOrgs);
    await db.deleteFrom('commerce_contacts').where('org_id', 'in', createdOrgs).execute();
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
          exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id')),
        ),
      )
      .execute();
  }
  await closeDb();
});

/** Consent rows are append-only by trigger; a fixture teardown is the one place that may lift it. */
async function dropConsentRows(orgIds: string[]): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`ALTER TABLE commerce_contact_consents DISABLE TRIGGER trg_commerce_consents_append_only`.execute(
      trx,
    );
    await trx.deleteFrom('commerce_contact_consents').where('org_id', 'in', orgIds).execute();
    await sql`ALTER TABLE commerce_contact_consents ENABLE TRIGGER trg_commerce_consents_append_only`.execute(
      trx,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Normalization, in isolation from HTTP
// ---------------------------------------------------------------------------------------------

describe('a typed phone number becomes E.164, or is refused', () => {
  it('accepts the punctuation people actually paste', () => {
    for (const input of ['+44 20 7946 0000', '+44-20-7946-0000', '+44 (20) 7946 0000', '004420 7946 0000']) {
      const result = normalizeE164(input);
      expect(result.ok, `${input} should normalize`).toBe(true);
      if (result.ok) expect(result.phoneE164).toBe('+442079460000');
    }
  });

  it('refuses a number with no country code rather than assuming one', () => {
    // The refusal IS the feature. A local-format number assumed to be domestic does not fail — it
    // resolves to a real person in whichever country we guessed, who then receives marketing they
    // never opted into and has no idea who we are.
    const result = normalizeE164('020 7946 0000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/country code/i);
  });

  it('refuses letters instead of silently deleting them', () => {
    // Stripping non-digits would turn "call me on 7946" into a number and send to what remained.
    expect(normalizeE164('+44 call me').ok).toBe(false);
    expect(normalizeE164('+1800FLOWERS').ok).toBe(false);
  });

  it('refuses an unassigned calling code', () => {
    const result = normalizeE164('+999123456789');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/calling code/i);
  });

  it('holds the E.164 length bound at both ends', () => {
    expect(normalizeE164('+44123').ok).toBe(false);
    expect(normalizeE164('+441234567890123456').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------------------------

describe('POST /orgs/:orgId/contacts', () => {
  it('creates a contact with normalized identity, tags and attributes', async () => {
    const t = await createTenant();
    const phone = uniquePhone();

    const res = await request(API)
      .post(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth)
      .send({
        // Deliberately messy: this is what a paste from a spreadsheet looks like.
        phoneE164: `  ${phone.slice(0, 3)} ${phone.slice(3, 7)} ${phone.slice(7)}  `,
        displayName: 'Priya Raman',
        attributes: { plan: 'pro', city: 'Leeds' },
        tags: ['VIP', 'newsletter'],
      });

    expect(res.status).toBe(201);
    const contact = res.body.data.contact;
    expect(contact.phoneE164).toBe(phone);
    expect(contact.displayName).toBe('Priya Raman');
    expect(contact.attributes).toEqual({ plan: 'pro', city: 'Leeds' });
    expect([...contact.tags].sort()).toEqual(['VIP', 'newsletter']);
    // Derived, never accepted from the request: it is the address messages are delivered to.
    expect(contact.externalId).toBe(phone.slice(1));
    // No consent was claimed, so none was invented.
    expect(res.body.data.consent).toBeNull();
  });

  it('records consent through the append-only path when the request carries provenance', async () => {
    const t = await createTenant();

    const res = await request(API)
      .post(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth)
      .send({
        phoneE164: uniquePhone(),
        displayName: 'Consented Customer',
        consent: {
          purpose: 'marketing',
          state: 'opted_in',
          source: 'web_form',
          evidence: 'https://acme.invalid/signup?list=spring',
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.consent).toMatchObject({
      purpose: 'marketing',
      state: 'opted_in',
      source: 'web_form',
      evidence: 'https://acme.invalid/signup?list=spring',
      // Attributed to the member who asserted it. A consent row nobody is named on is one nobody
      // can be asked about.
      recordedByUserId: t.owner.id,
    });

    // It is a real row in the real history, not a value echoed back out of the request.
    const history = await request(API)
      .get(`/orgs/${t.orgId}/contacts/${res.body.data.contact.id}/consents`)
      .set('Authorization', t.owner.auth);
    expect(history.status).toBe(200);
    expect(history.body.data.consents).toHaveLength(1);
  });

  it('refuses consent with empty evidence — an unproved opt-in is not one', async () => {
    const t = await createTenant();

    const res = await request(API)
      .post(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth)
      .send({
        phoneE164: uniquePhone(),
        consent: { purpose: 'marketing', state: 'opted_in', source: 'import', evidence: '   ' },
      });

    expect(res.status).toBe(400);
  });

  it('writes an opt-out consent straight onto the suppression list', async () => {
    const t = await createTenant();
    const phone = uniquePhone();

    const res = await request(API)
      .post(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth)
      .send({
        phoneE164: phone,
        consent: {
          purpose: 'marketing',
          state: 'opted_out',
          source: 'import',
          evidence: 'unsubscribes.csv, exported 2026-08-01',
        },
      });
    expect(res.status).toBe(201);

    // Importing a suppression list is a real reason to add a contact who must never be messaged.
    // A consent row recording the opt-out without a suppression would be perfectly documented and
    // stop nothing.
    const suppressions = await request(API)
      .get(`/orgs/${t.orgId}/suppressions`)
      .set('Authorization', t.owner.auth);
    expect(suppressions.status).toBe(200);
    expect(
      suppressions.body.data.suppressions.some(
        (s: { externalId: string }) => s.externalId === phone.slice(1),
      ),
    ).toBe(true);
  });

  it('is the SAME row the webhook would upsert, not a second identity', async () => {
    const t = await createTenant();
    const phone = uniquePhone();

    const created = await request(API)
      .post(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth)
      .send({ phoneE164: phone, displayName: 'Hand Entered' });
    expect(created.status).toBe(201);

    // Exactly what commerceInboundService does when this person messages in for the first time.
    const upsertedId = await commerceInboxRepository.upsertContact({
      orgId: t.orgId,
      platform: 'whatsapp_cloud',
      externalId: phone.slice(1),
      displayName: null,
      phoneE164: phone,
    });

    // One human, one row. Two rows would split their consent history, and the send gate would read
    // whichever one the segment happened to select.
    expect(upsertedId).toBe(created.body.data.contact.id);

    // The webhook reporting no profile name must not blank the name an operator typed.
    const after = await request(API)
      .get(`/orgs/${t.orgId}/contacts/${upsertedId}`)
      .set('Authorization', t.owner.auth);
    expect(after.body.data.contact.displayName).toBe('Hand Entered');
  });

  it('refuses a duplicate with a conflict rather than merging silently', async () => {
    const t = await createTenant();
    const phone = uniquePhone();
    const body = { phoneE164: phone, displayName: 'First Entry' };

    expect((await request(API).post(`/orgs/${t.orgId}/contacts`).set('Authorization', t.owner.auth).send(body)).status).toBe(201);

    const second = await request(API)
      .post(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth)
      .send({ phoneE164: phone, displayName: 'Second Entry' });
    expect(second.status).toBe(409);

    // The first entry is untouched. A silent merge here is how an import overwrites a name an
    // operator corrected by hand, with nothing anywhere to show it happened.
    const list = await request(API)
      .get(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth);
    const matching = list.body.data.contacts.filter(
      (c: { phoneE164: string }) => c.phoneE164 === phone,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].displayName).toBe('First Entry');
  });

  it('refuses an attribute name no segment rule could ever reference', async () => {
    const t = await createTenant();

    // A key the compiler cannot target is a field the client fills in and can then never use —
    // which looks like the feature working, right up until the campaign that needed it.
    const res = await request(API)
      .post(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth)
      .send({ phoneE164: uniquePhone(), attributes: { 'not a key!': 'x' } });

    expect(res.status).toBe(400);
  });

  it('lets an agent read contacts but not create one', async () => {
    const t = await createTenant();
    const agent = await addMember(t.orgId, 'agent');

    expect(
      (await request(API).get(`/orgs/${t.orgId}/contacts`).set('Authorization', agent.auth)).status,
    ).toBe(200);

    // Asserting that the organization holds someone's number — and that they agreed to be messaged —
    // is not a step in answering an inbox message.
    const created = await request(API)
      .post(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', agent.auth)
      .send({ phoneE164: uniquePhone() });
    expect(created.status).toBe(403);
  });

  it('does not let a member of one org add a contact to another', async () => {
    const a = await createTenant();
    const b = await createTenant();

    const crossing = await request(API)
      .post(`/orgs/${b.orgId}/contacts`)
      .set('Authorization', a.owner.auth)
      .send({ phoneE164: uniquePhone() });

    // 404, not 403: a 403 confirms the org id exists, turning an id that appears in invite links
    // into an enumeration oracle.
    expect(crossing.status).toBe(404);
  });
});
