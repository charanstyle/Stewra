import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { config } from '../config/unifiedConfig.js';
import { db, closeDb } from '../database/index.js';
import { errorHandler } from '../middleware/errorHandler.js';
import orgRoutes from '../tenancy/routes/organizations.js';
import commerceOrgRoutes from '../commerce/routes/orgSurface.js';
import { organizationRepository } from '../tenancy/repositories/organizationRepository.js';
import { consentRepository } from '../commerce/repositories/consentRepository.js';
import { consentService } from '../commerce/services/consentService.js';

/**
 * CONSENT. The gate between "this organization wants to message someone" and the person's phone.
 *
 * The properties asserted here are the ones that decide whether a client's WhatsApp number survives:
 * that absence never permits a send, that STOP takes effect from the customer's own message rather
 * than from an operator's screen, that a block follows the ADDRESS across a contact being deleted
 * and re-imported, and that the consent trail cannot be rewritten after the fact.
 *
 * Nothing is stood in for — real Postgres, the real router, the real
 * `requireAuth` → `requireEmailVerification` → `requireOrgMember` chain, real signed bearer tokens.
 * The append-only rule in particular is asserted against the DATABASE, not against the repository
 * that avoids breaking it: a rule enforced only in application code is one careless `.updateTable()`
 * from gone, and the row it would rewrite is the evidence.
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
      email: `commerce-consent-${randomUUID()}@stewra.invalid`,
      display_name: 'Commerce Consent Test User',
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
  readonly contactId: string;
  readonly externalId: string;
}

/** An org with one owner and one WhatsApp contact already in its inbox. */
async function createTenant(): Promise<Tenant> {
  const owner = await createUser();
  const { org } = await organizationRepository.create({
    name: 'Consent Test Co',
    slug: `consent-${randomUUID().slice(0, 8)}`,
    createdBy: owner.id,
  });
  createdOrgs.push(org.id);

  // A plausible E.164 without the '+', which is exactly the shape Meta's `wa_id` has.
  const externalId = `4477${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const contact = await db
    .insertInto('commerce_contacts')
    .values({
      org_id: org.id,
      platform: 'whatsapp_cloud',
      external_id: externalId,
      display_name: 'Dana Okonkwo',
      phone_e164: `+${externalId}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { owner, orgId: org.id, contactId: contact.id, externalId };
}

/** Put an existing user into an org at a given role, bypassing the invite dance. */
async function addMember(orgId: string, role: 'admin' | 'agent' | 'viewer'): Promise<TestUser> {
  const user = await createUser();
  await db.insertInto('org_members').values({ org_id: orgId, user_id: user.id, role }).execute();
  return user;
}

/** Bring an org all the way to "may send marketing": quiet hours set, attestation signed. */
async function fullyConfigure(t: Tenant, quiet = { start: '21:00', end: '09:00' }): Promise<void> {
  await consentService.setQuietHours({
    orgId: t.orgId,
    timezone: 'UTC',
    quietHoursStart: quiet.start,
    quietHoursEnd: quiet.end,
  });
  await consentService.attest({
    orgId: t.orgId,
    attestedByUserId: t.owner.id,
    attestationText: 'We hold documented opt-in for every contact on this list.',
  });
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    await db.deleteFrom('commerce_messaging_policies').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_suppressions').where('org_id', 'in', createdOrgs).execute();
    // The append-only trigger fires on DELETE too, so the evidence rows have to be dropped with the
    // trigger momentarily off. Cleaning up a test fixture is the one case where that is legitimate,
    // and it is done here in the harness rather than by weakening the trigger itself.
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

/**
 * Delete this suite's consent rows with the append-only trigger momentarily off.
 *
 * Without this the fixture rows would accumulate in `stewra_test` forever, since the trigger —
 * correctly — refuses DELETE. Disabling and re-enabling inside ONE transaction is what keeps that
 * safe: `ALTER TABLE ... DISABLE TRIGGER` is a catalog change rather than a session setting, but it
 * is transactional and takes an ACCESS EXCLUSIVE lock, so no other session can see or write the
 * table while the trigger is off, and the committed state is unchanged. Test-fixture cleanup on a
 * dedicated database is the only place this is legitimate; production code never disables it.
 */
async function dropConsentRows(orgIds: string[]): Promise<void> {
  const { sql } = await import('kysely');
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

describe('the send gate refuses on absence', () => {
  it('refuses a marketing send when the organization has set no messaging policy at all', async () => {
    const t = await createTenant();
    await expect(
      consentService.assertMaySend({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        externalId: t.externalId,
        purpose: 'marketing',
      }),
    ).rejects.toMatchObject({ code: 'NO_MESSAGING_POLICY' });
  });

  it('refuses when quiet hours exist but nobody has attested to lawful opt-in', async () => {
    const t = await createTenant();
    await consentService.setQuietHours({
      orgId: t.orgId,
      timezone: 'UTC',
      quietHoursStart: '21:00',
      quietHoursEnd: '09:00',
    });
    await expect(
      consentService.assertMaySend({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        externalId: t.externalId,
        purpose: 'marketing',
      }),
    ).rejects.toMatchObject({ code: 'NOT_ATTESTED' });
  });

  it('refuses a fully configured org when no consent is on file for the contact', async () => {
    const t = await createTenant();
    await fullyConfigure(t);
    await expect(
      consentService.assertMaySend({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        externalId: t.externalId,
        purpose: 'marketing',
      }),
    ).rejects.toMatchObject({ code: 'NO_MARKETING_CONSENT' });
  });

  it('permits the send once policy, attestation and an opt-in are all in place', async () => {
    const t = await createTenant();
    await fullyConfigure(t);
    await consentService.recordConsent({
      orgId: t.orgId,
      contactId: t.contactId,
      platform: 'whatsapp_cloud',
      purpose: 'marketing',
      state: 'opted_in',
      source: 'web_form',
      evidence: 'https://acme.example/newsletter — submitted 2026-07-02',
      recordedByUserId: t.owner.id,
    });
    // Midday UTC, comfortably outside the 21:00–09:00 quiet window.
    await expect(
      consentService.assertMaySend({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        externalId: t.externalId,
        purpose: 'marketing',
        now: new Date('2026-07-02T12:00:00Z'),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('quiet hours', () => {
  it('refuses inside a window that wraps midnight, and permits outside it', async () => {
    const t = await createTenant();
    await fullyConfigure(t, { start: '21:00', end: '09:00' });
    await consentService.recordConsent({
      orgId: t.orgId,
      contactId: t.contactId,
      platform: 'whatsapp_cloud',
      purpose: 'marketing',
      state: 'opted_in',
      source: 'ad_click',
      evidence: 'ad:120210000000000123',
      recordedByUserId: t.owner.id,
    });

    const send = (iso: string): Promise<void> =>
      consentService.assertMaySend({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        externalId: t.externalId,
        purpose: 'marketing',
        now: new Date(iso),
      });

    // 03:00 is on the far side of midnight from the 21:00 start — the case a naive
    // `start <= now < end` comparison gets exactly backwards, and it is the 3am send that generates
    // the complaint.
    await expect(send('2026-07-02T03:00:00Z')).rejects.toMatchObject({ code: 'QUIET_HOURS' });
    await expect(send('2026-07-02T22:30:00Z')).rejects.toMatchObject({ code: 'QUIET_HOURS' });
    await expect(send('2026-07-02T09:00:00Z')).resolves.toBeUndefined();
    await expect(send('2026-07-02T20:59:00Z')).resolves.toBeUndefined();
  });

  it('evaluates the window in the organization\'s declared timezone, not the server\'s', async () => {
    const t = await createTenant();
    // 22:00–06:00 in Tokyo. The instant below is 14:00 UTC — daytime by the server's clock and
    // 23:00 by the org's, so a gate that quietly evaluated UTC would send in the middle of their
    // night while showing the operator a correctly configured window.
    await fullyConfigure(t, { start: '22:00', end: '06:00' });
    await db
      .updateTable('commerce_messaging_policies')
      .set({ timezone: 'Asia/Tokyo' })
      .where('org_id', '=', t.orgId)
      .execute();
    await consentService.recordConsent({
      orgId: t.orgId,
      contactId: t.contactId,
      platform: 'whatsapp_cloud',
      purpose: 'marketing',
      state: 'opted_in',
      source: 'import',
      evidence: 'customers-2026-06.csv',
      recordedByUserId: t.owner.id,
    });

    await expect(
      consentService.assertMaySend({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        externalId: t.externalId,
        purpose: 'marketing',
        now: new Date('2026-07-02T14:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'QUIET_HOURS' });
  });

  it('rejects a timezone the runtime cannot resolve, at write time rather than at send time', async () => {
    const t = await createTenant();
    await expect(
      consentService.setQuietHours({
        orgId: t.orgId,
        timezone: 'Mars/Olympus_Mons',
        quietHoursStart: '21:00',
        quietHoursEnd: '09:00',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // And nothing was written — a rejected policy must not leave a half-applied row behind.
    expect(await consentRepository.findPolicy(t.orgId)).toBeNull();
  });
});

describe('opting out', () => {
  it('applies a customer\'s "STOP" from their own message, and blocks the next send', async () => {
    const t = await createTenant();
    await fullyConfigure(t);
    await consentService.recordConsent({
      orgId: t.orgId,
      contactId: t.contactId,
      platform: 'whatsapp_cloud',
      purpose: 'marketing',
      state: 'opted_in',
      source: 'web_form',
      evidence: 'https://acme.example/signup',
      recordedByUserId: t.owner.id,
    });

    const wamid = `wamid.${randomUUID()}`;
    const applied = await consentService.applyInboundKeyword({
      orgId: t.orgId,
      contactId: t.contactId,
      platform: 'whatsapp_cloud',
      externalId: t.externalId,
      body: ' STOP ',
      providerMessageId: wamid,
    });

    expect(applied).not.toBeNull();
    expect(applied?.state).toBe('opted_out');
    // The customer's own message id is the evidence — re-readable on the platform rather than
    // taken on our word.
    expect(applied?.evidence).toBe(wamid);
    expect(applied?.source).toBe('keyword');

    // Both halves have to happen. The consent row is the proof; the suppression is what the gate
    // actually reads. Recording only the first would leave a perfectly documented opt-out that
    // stops nothing.
    await expect(
      consentService.assertMaySend({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        externalId: t.externalId,
        purpose: 'marketing',
        now: new Date('2026-07-02T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'CONTACT_SUPPRESSED' });
  });

  it('blocks a SERVICE reply too, even with the 24-hour window wide open', async () => {
    const t = await createTenant();
    await consentService.applyInboundKeyword({
      orgId: t.orgId,
      contactId: t.contactId,
      platform: 'whatsapp_cloud',
      externalId: t.externalId,
      body: 'unsubscribe',
      providerMessageId: `wamid.${randomUUID()}`,
    });
    // The service window is Meta's DELIVERY rule, not permission. Someone who asked to be left alone
    // has one open for exactly as long as anyone else, and answering them anyway is the failure this
    // assertion exists to catch.
    await expect(
      consentService.assertMaySend({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        externalId: t.externalId,
        purpose: 'service',
      }),
    ).rejects.toMatchObject({ code: 'CONTACT_SUPPRESSED' });
  });

  it('does not treat a message that merely CONTAINS a keyword as an opt-out', async () => {
    const t = await createTenant();
    const applied = await consentService.applyInboundKeyword({
      orgId: t.orgId,
      contactId: t.contactId,
      platform: 'whatsapp_cloud',
      externalId: t.externalId,
      body: "I'd like to stop by on Tuesday, is 3pm ok?",
      providerMessageId: `wamid.${randomUUID()}`,
    });
    expect(applied).toBeNull();
    expect(await consentRepository.isSuppressed(t.orgId, 'whatsapp_cloud', t.externalId)).toBeNull();
  });

  it('lets a customer opt back in with START, lifting the block', async () => {
    const t = await createTenant();
    await fullyConfigure(t);
    await consentService.applyInboundKeyword({
      orgId: t.orgId,
      contactId: t.contactId,
      platform: 'whatsapp_cloud',
      externalId: t.externalId,
      body: 'STOP',
      providerMessageId: `wamid.${randomUUID()}`,
    });
    const back = await consentService.applyInboundKeyword({
      orgId: t.orgId,
      contactId: t.contactId,
      platform: 'whatsapp_cloud',
      externalId: t.externalId,
      body: 'start',
      providerMessageId: `wamid.${randomUUID()}`,
    });

    expect(back?.state).toBe('opted_in');
    expect(await consentRepository.isSuppressed(t.orgId, 'whatsapp_cloud', t.externalId)).toBeNull();
    await expect(
      consentService.assertMaySend({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        externalId: t.externalId,
        purpose: 'marketing',
        now: new Date('2026-07-02T12:00:00Z'),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('the suppression list survives the contact record', () => {
  it('still blocks after the contact row is deleted and the same person re-imported', async () => {
    const t = await createTenant();
    await fullyConfigure(t);
    await consentService.suppress({
      orgId: t.orgId,
      platform: 'whatsapp_cloud',
      externalId: t.externalId,
      reason: 'complaint',
      detail: 'Reported the business to Meta',
    });

    // The exact scenario the address key exists for: someone deletes the contact, re-uploads their
    // list next quarter, and the same human comes back with a brand-new contact id. A block attached
    // to the ROW would have evaporated at this point.
    await dropConsentRows([t.orgId]);
    await db.deleteFrom('commerce_contacts').where('id', '=', t.contactId).execute();
    const reimported = await db
      .insertInto('commerce_contacts')
      .values({
        org_id: t.orgId,
        platform: 'whatsapp_cloud',
        external_id: t.externalId,
        display_name: 'Dana O.',
        phone_e164: `+${t.externalId}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    expect(reimported.id).not.toBe(t.contactId);
    await expect(
      consentService.assertMaySend({
        orgId: t.orgId,
        contactId: reimported.id,
        platform: 'whatsapp_cloud',
        externalId: t.externalId,
        purpose: 'marketing',
        now: new Date('2026-07-02T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'CONTACT_SUPPRESSED' });
  });

  it('keeps the FIRST reason when the same address is suppressed twice', async () => {
    const t = await createTenant();
    await consentService.suppress({
      orgId: t.orgId,
      platform: 'whatsapp_cloud',
      externalId: t.externalId,
      reason: 'opt_out',
      detail: 'Customer replied "STOP"',
    });
    await consentService.suppress({
      orgId: t.orgId,
      platform: 'whatsapp_cloud',
      externalId: t.externalId,
      reason: 'manual',
      detail: 'Added from the July import',
    });
    // The opt-out is the record that matters; a later bulk import must not overwrite the evidence
    // that this person asked to be left alone.
    const found = await consentRepository.isSuppressed(t.orgId, 'whatsapp_cloud', t.externalId);
    expect(found?.reason).toBe('opt_out');
  });

  it('one org\'s suppression does not silence the same person for another org', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await fullyConfigure(b);
    // Same human, two clients. Suppress at A, then check B is untouched — a global block list would
    // let one business's complaint take a customer away from an unrelated one.
    await consentService.suppress({
      orgId: a.orgId,
      platform: 'whatsapp_cloud',
      externalId: b.externalId,
      reason: 'complaint',
      detail: null,
    });
    expect(await consentRepository.isSuppressed(b.orgId, 'whatsapp_cloud', b.externalId)).toBeNull();
  });
});

describe('the consent trail cannot be rewritten', () => {
  it('rejects an UPDATE of a consent row at the database, not merely in the repository', async () => {
    const t = await createTenant();
    const consent = await consentService.recordConsent({
      orgId: t.orgId,
      contactId: t.contactId,
      platform: 'whatsapp_cloud',
      purpose: 'marketing',
      state: 'opted_out',
      source: 'attested',
      evidence: 'Told us on the phone, 2026-06-30',
      recordedByUserId: t.owner.id,
    });

    // Going around the repository on purpose. The repository has no update method, so asserting
    // against it would only prove the API surface; the guarantee has to hold against whatever
    // someone writes next year, which means it has to be the trigger.
    await expect(
      db
        .updateTable('commerce_contact_consents')
        .set({ state: 'opted_in' })
        .where('id', '=', consent.id)
        .execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('records an opt-out as a NEW row, leaving the original opt-in readable', async () => {
    const t = await createTenant();
    for (const state of ['opted_in', 'opted_out'] as const) {
      await consentService.recordConsent({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        purpose: 'marketing',
        state,
        source: state === 'opted_in' ? 'web_form' : 'attested',
        evidence: state === 'opted_in' ? 'https://acme.example/signup' : 'Emailed us to unsubscribe',
        recordedByUserId: t.owner.id,
      });
    }

    const history = await consentService.listConsentHistory(t.orgId, t.contactId);
    expect(history).toHaveLength(2);
    const [newest, oldest] = history;
    // Newest first, and the older row is still there — which is what makes a message sent last
    // month defensible against what was on file last month.
    expect(newest?.state).toBe('opted_out');
    expect(oldest?.state).toBe('opted_in');
    expect(oldest?.evidence).toBe('https://acme.example/signup');
  });

  it('refuses to record consent with blank evidence', async () => {
    const t = await createTenant();
    await expect(
      consentService.recordConsent({
        orgId: t.orgId,
        contactId: t.contactId,
        platform: 'whatsapp_cloud',
        purpose: 'marketing',
        state: 'opted_in',
        source: 'import',
        evidence: '   ',
        recordedByUserId: t.owner.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('the attestation is a signature, not a setting', () => {
  it('cannot be recorded before quiet hours exist', async () => {
    const t = await createTenant();
    await expect(
      consentService.attest({
        orgId: t.orgId,
        attestedByUserId: t.owner.id,
        attestationText: 'We hold documented opt-in.',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('is not cleared by a later quiet-hours edit, and stores the sentence verbatim', async () => {
    const t = await createTenant();
    const sentence = 'Every contact on this list gave written opt-in on our booking form.';
    await consentService.setQuietHours({
      orgId: t.orgId,
      timezone: 'Europe/London',
      quietHoursStart: '20:00',
      quietHoursEnd: '08:00',
    });
    await consentService.attest({
      orgId: t.orgId,
      attestedByUserId: t.owner.id,
      attestationText: sentence,
    });
    await consentService.setQuietHours({
      orgId: t.orgId,
      timezone: 'Europe/London',
      quietHoursStart: '21:30',
      quietHoursEnd: '07:30',
    });

    const policy = await consentRepository.findPolicy(t.orgId);
    expect(policy?.attestationText).toBe(sentence);
    expect(policy?.attestedAt).not.toBeNull();
    expect(policy?.quietHoursStart).toBe('21:30');
  });
});

describe('the HTTP surface and its roles', () => {
  it('lets an owner set quiet hours, attest, and read the policy back', async () => {
    const t = await createTenant();
    const put = await request(API)
      .put(`/orgs/${t.orgId}/messaging-policy`)
      .set('Authorization', t.owner.auth)
      .send({ timezone: 'Europe/London', quietHoursStart: '21:00', quietHoursEnd: '09:00' });
    expect(put.status).toBe(200);
    expect(put.body.data.policy.quietHoursStart).toBe('21:00');

    const attest = await request(API)
      .post(`/orgs/${t.orgId}/messaging-policy/attestation`)
      .set('Authorization', t.owner.auth)
      .send({ attestationText: 'We hold documented opt-in for every contact.' });
    expect(attest.status).toBe(201);

    const get = await request(API)
      .get(`/orgs/${t.orgId}/messaging-policy`)
      .set('Authorization', t.owner.auth);
    expect(get.status).toBe(200);
    expect(get.body.data.policy.attestedByUserId).toBe(t.owner.id);
  });

  it('will not let an agent record consent or attest — those are admin and owner actions', async () => {
    const t = await createTenant();
    const agent = await addMember(t.orgId, 'agent');

    const record = await request(API)
      .post(`/orgs/${t.orgId}/contacts/${t.contactId}/consents`)
      .set('Authorization', agent.auth)
      .send({ purpose: 'marketing', state: 'opted_in', source: 'import', evidence: 'list.csv' });
    expect(record.status).toBe(403);

    // An admin may record consent but still may not sign the attestation: one is data entry, the
    // other is the organization putting its name to a compliance claim.
    const admin = await addMember(t.orgId, 'admin');
    const adminRecord = await request(API)
      .post(`/orgs/${t.orgId}/contacts/${t.contactId}/consents`)
      .set('Authorization', admin.auth)
      .send({ purpose: 'marketing', state: 'opted_in', source: 'import', evidence: 'list.csv' });
    expect(adminRecord.status).toBe(201);

    await request(API)
      .put(`/orgs/${t.orgId}/messaging-policy`)
      .set('Authorization', admin.auth)
      .send({ timezone: 'UTC', quietHoursStart: '21:00', quietHoursEnd: '09:00' })
      .expect(200);

    const adminAttest = await request(API)
      .post(`/orgs/${t.orgId}/messaging-policy/attestation`)
      .set('Authorization', admin.auth)
      .send({ attestationText: 'We hold documented opt-in.' });
    expect(adminAttest.status).toBe(403);
  });

  it('lets a viewer READ the suppression list — an agent needs to see why a send is blocked', async () => {
    const t = await createTenant();
    const viewer = await addMember(t.orgId, 'viewer');
    await consentService.suppress({
      orgId: t.orgId,
      platform: 'whatsapp_cloud',
      externalId: t.externalId,
      reason: 'opt_out',
      detail: null,
    });

    const list = await request(API)
      .get(`/orgs/${t.orgId}/suppressions`)
      .set('Authorization', viewer.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.suppressions).toHaveLength(1);

    // But not write it.
    const post = await request(API)
      .post(`/orgs/${t.orgId}/suppressions`)
      .set('Authorization', viewer.auth)
      .send({ platform: 'whatsapp_cloud', externalId: t.externalId, reason: 'manual' });
    expect(post.status).toBe(403);
  });

  it('will not show one organization\'s consent trail to a member of another', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await consentService.recordConsent({
      orgId: a.orgId,
      contactId: a.contactId,
      platform: 'whatsapp_cloud',
      purpose: 'marketing',
      state: 'opted_in',
      source: 'web_form',
      evidence: 'https://a.example/signup',
      recordedByUserId: a.owner.id,
    });

    // 404 rather than 403, matching the rest of the commerce surface: a 403 would confirm the org id
    // exists, turning ids that appear in invite links into an enumeration oracle.
    const res = await request(API)
      .get(`/orgs/${a.orgId}/contacts/${a.contactId}/consents`)
      .set('Authorization', b.owner.auth);
    expect(res.status).toBe(404);
  });

  it('records the platform from the contact row rather than from the request body', async () => {
    const t = await createTenant();
    const res = await request(API)
      .post(`/orgs/${t.orgId}/contacts/${t.contactId}/consents`)
      .set('Authorization', t.owner.auth)
      .send({
        purpose: 'marketing',
        state: 'opted_in',
        source: 'web_form',
        evidence: 'https://acme.example/signup',
        // A caller asserting a platform this contact has never been reached on. Ignored: the
        // platform is a property of who the person is to this org, and honouring it would let one
        // request manufacture consent for a channel nobody agreed to.
        platform: 'instagram',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.consent.platform).toBe('whatsapp_cloud');
  });

  it('rejects an unauthenticated read of the policy', async () => {
    const t = await createTenant();
    await request(API).get(`/orgs/${t.orgId}/messaging-policy`).expect(401);
  });
});
