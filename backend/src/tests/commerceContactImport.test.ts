import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { sql } from 'kysely';
import type { closeDb as closeDbType, db as dbType } from '../database/index.js';

/**
 * IMPORTING A LIST — the door that carries other people's consent through it.
 *
 * A business's opt-in list arrives as a spreadsheet. Until this endpoint the only way in was one
 * contact at a time, which for a real list means it never happens, which means the commerce plane
 * stays empty and the consent regime never gets tested by the thing it exists for.
 *
 * The properties defended here are the ones that make a BULK door safe:
 *
 *   - **consent is required per row, and never guessed.** The single-contact form leaves consent
 *     optional because the person typing it is present and answerable; a file has no such presence,
 *     and a bulk list without provenance is exactly the purchased list this regime refuses. A row
 *     with no consent is REPORTED, not imported-without-it.
 *   - **rows go through `audienceService.createContact`,** the same path the form uses, so an
 *     importer cannot create a contact the send gate understands differently.
 *   - **the ledger makes the job idempotent.** A run that is interrupted resumes; a run that happens
 *     twice imports nobody twice.
 *   - **a file that is wrong as a FILE is refused at the door,** as a 400 while the operator is
 *     still looking at the upload box — not twenty minutes later as an import that failed.
 *
 * Real Postgres, the real router, the real middleware chain over real HTTP, and the real job handler
 * claimed off the real queue. No Meta stub: an import sends nothing.
 */

const APP_ID = '100000000000001';

process.env['META_COMMERCE_ENABLED'] = 'true';
process.env['META_COMMERCE_APP_ID'] = APP_ID;
process.env['META_COMMERCE_APP_SECRET'] = randomBytes(16).toString('hex');
process.env['META_COMMERCE_CONFIG_ID'] = '200000000000003';
process.env['META_COMMERCE_VERIFY_TOKEN'] = `verify-${randomBytes(8).toString('hex')}`;

const database = (await import('../database/index.js')) as {
  db: typeof dbType;
  closeDb: typeof closeDbType;
};
const { db } = database;
const { config } = await import('../config/unifiedConfig.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const orgRoutes = (await import('../tenancy/routes/organizations.js')).default;
const commerceOrgRoutes = (await import('../commerce/routes/orgSurface.js')).default;
const { organizationRepository } = await import(
  '../tenancy/repositories/organizationRepository.js'
);
const { jobRepository } = await import('../commerce/repositories/jobRepository.js');
const { contactImportHandler } = await import('../commerce/jobs/contactImportHandler.js');
const { parseContactCsv } = await import('../commerce/services/csvContacts.js');

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
      email: `commerce-import-${randomUUID()}@stewra.invalid`,
      display_name: 'Import Test User',
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
    name: 'Import Co',
    slug: `import-${randomUUID().slice(0, 8)}`,
    createdBy: owner.id,
  });
  createdOrgs.push(org.id);
  return { owner, orgId: org.id };
}

async function addMember(orgId: string, role: 'admin' | 'agent' | 'viewer'): Promise<TestUser> {
  const user = await createUser();
  await db.insertInto('org_members').values({ org_id: orgId, user_id: user.id, role }).execute();
  return user;
}

/** Distinct, well-formed UK mobiles so no two tests collide on the unique contact index. */
let phoneCounter = Math.floor(Math.random() * 5_000_000);
function uniquePhone(): string {
  phoneCounter += 1;
  return `+4477${String(10_000_000 + phoneCounter).slice(0, 8)}`;
}

/** Upload a CSV exactly as a browser would, and hand back the created import. */
async function upload(
  orgId: string,
  auth: string,
  csv: string,
  filename = 'list.csv',
): Promise<request.Response> {
  return request(API)
    .post(`/orgs/${orgId}/contacts/import`)
    .set('Authorization', auth)
    .attach('file', Buffer.from(csv, 'utf8'), { filename, contentType: 'text/csv' });
}

/**
 * Drain the queue the way the worker does — claim, handle, repeat.
 *
 * Claimed rather than hand-constructed, because the handler's continuation behaviour (it enqueues
 * the next chunk of a large file and returns) is only exercised by something that goes back for the
 * job it just created.
 */
async function drain(limit = 20): Promise<number> {
  let ran = 0;
  for (let pass = 0; pass < limit; pass += 1) {
    const jobs = await jobRepository.claim(`test-${randomUUID()}`, 60, 5);
    const imports = jobs.filter((job) => job.kind === 'contact_import');
    if (imports.length === 0) break;
    for (const job of imports) {
      const outcome = await contactImportHandler.handle(job);
      expect(outcome.kind, JSON.stringify(outcome)).toBe('done');
      await jobRepository.markDone(job.id);
      ran += 1;
    }
  }
  return ran;
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    await db
      .deleteFrom('commerce_contact_import_rows')
      .where('import_id', 'in', (qb) =>
        qb
          .selectFrom('commerce_contact_imports')
          .select('id')
          .where('org_id', 'in', createdOrgs),
      )
      .execute();
    await db.deleteFrom('commerce_contact_imports').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_jobs').where('org_id', 'in', createdOrgs).execute();
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
  await database.closeDb();
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

const HEADER = 'phone,name,tags,consent_purpose,consent_state,consent_source,consent_evidence';

/**
 * The byte-order mark Excel writes in front of every CSV it saves.
 *
 * Built from its code point rather than pasted, because pasted it is an invisible character in the
 * source — indistinguishable from nothing at all in a diff, which is the same trick it plays on the
 * header row of a real upload.
 */
const BOM = String.fromCharCode(0xfeff);

function row(phone: string, name = 'Someone', extra = ''): string {
  return `${phone},${name},${extra || 'vip;newsletter'},marketing,opted_in,web_form,https://acme.invalid/signup`;
}

// ---------------------------------------------------------------------------------------------
// The reader, in isolation from HTTP and Postgres
// ---------------------------------------------------------------------------------------------

describe('reading a CSV that a real spreadsheet produced', () => {
  it('handles quotes, embedded commas and newlines, doubled quotes, CRLF and a BOM', () => {
    const csv =
      `${BOM}${HEADER}\r\n` +
      `+442079460000,"Raman, Priya","vip;uk",marketing,opted_in,web_form,"https://acme.invalid/s?a=1,2"\r\n` +
      `+442079460001,"O""Brien","",service,opted_in,inbound_message,"asked us\nin chat"\r\n`;

    const parsed = parseContactCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toHaveLength(2);

    const first = parsed.rows[0];
    expect(first?.ok).toBe(true);
    if (first?.ok !== true) return;
    // The BOM did not become part of the `phone` column name, which would have refused the file for
    // missing the very column the operator is looking straight at.
    expect(first.phoneE164).toBe('+442079460000');
    expect(first.displayName).toBe('Raman, Priya');
    expect([...first.tags].sort()).toEqual(['uk', 'vip']);
    expect(first.consent.evidence).toBe('https://acme.invalid/s?a=1,2');

    const second = parsed.rows[1];
    expect(second?.ok).toBe(true);
    if (second?.ok !== true) return;
    expect(second.displayName).toBe('O"Brien');
    expect(second.consent.evidence).toContain('\n');
  });

  it('reads every unreserved column as an attribute the segment compiler could target', () => {
    const parsed = parseContactCsv(
      `phone,consent_purpose,consent_state,consent_source,consent_evidence,plan,city\n` +
        `+442079460002,marketing,opted_in,import,spring-list.csv,pro,Leeds\n`,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const only = parsed.rows[0];
    if (only?.ok !== true) throw new Error('expected a usable row');
    expect(only.attributes).toEqual({ plan: 'pro', city: 'Leeds' });
  });

  it('refuses the whole file when the consent columns are missing', () => {
    // Not per row. A file with no consent columns has nothing to report row by row — the finding is
    // about the file, and nine hundred identical skips would bury the one sentence that fixes it.
    const parsed = parseContactCsv('phone,name\n+442079460003,Someone\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/consent_source/);
  });

  it('refuses a file with the same column twice', () => {
    const parsed = parseContactCsv(`${HEADER},name\n${row('+442079460004')},Other\n`);
    expect(parsed.ok).toBe(false);
  });

  it('refuses an attribute column no segment rule could ever reference', () => {
    const parsed = parseContactCsv(
      `phone,consent_purpose,consent_state,consent_source,consent_evidence,order total!\n` +
        `+442079460005,marketing,opted_in,import,list.csv,12\n`,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/order total!/);
  });

  it('refuses a header with no rows under it', () => {
    expect(parseContactCsv(`${HEADER}\n`).ok).toBe(false);
  });

  it('rejects rows individually for the things that are about the row', () => {
    const csv =
      `${HEADER}\n` +
      `020 7946 0000,No Country Code,,marketing,opted_in,web_form,form\n` +
      `+442079460010,No Consent At All,,,,,\n` +
      `+442079460011,Bad Source,,marketing,opted_in,carrier_pigeon,form\n` +
      `+442079460012,Empty Evidence,,marketing,opted_in,web_form,\n` +
      `+442079460013,First Time,,marketing,opted_in,web_form,form\n` +
      `+442079460013,Again,,marketing,opted_out,web_form,form\n`;

    const parsed = parseContactCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const reasons = parsed.rows.map((r) => (r.ok ? 'ok' : r.reason));
    expect(reasons).toEqual([
      // A local-format number is refused, never assumed domestic — a guess resolves to a real
      // stranger who then receives marketing they never asked for.
      'invalid_phone',
      'missing_consent',
      'invalid_consent',
      'invalid_consent',
      'ok',
      // The second appearance is refused rather than merged: the two rows disagree about the opt-in
      // state, and letting the last line win is how an opt-out gets silently overwritten.
      'duplicate_in_file',
    ]);

    const dupe = parsed.rows[5];
    if (dupe?.ok !== false) throw new Error('expected a rejection');
    expect(dupe.detail).toMatch(/row 5/);
  });
});

// ---------------------------------------------------------------------------------------------
// The endpoint and the job
// ---------------------------------------------------------------------------------------------

describe('POST /orgs/:orgId/contacts/import', () => {
  it('imports the good rows, reports the rest, and messages nobody in between', async () => {
    const t = await createTenant();
    const good = uniquePhone();
    const optedOut = uniquePhone();
    const noConsent = uniquePhone();

    const csv =
      `${HEADER}\n` +
      `${row(good, 'Priya Raman')}\n` +
      `${optedOut},Left Us,,marketing,opted_out,import,unsubscribes.csv\n` +
      `${noConsent},Unknown Provenance,,,,,\n` +
      `not a phone,Broken,,marketing,opted_in,web_form,form\n`;

    const accepted = await upload(t.orgId, t.owner.auth, csv);
    // 202, not 201: the import exists, the contacts do not yet.
    expect(accepted.status).toBe(202);
    const importId = accepted.body.data.import.id;
    expect(accepted.body.data.import.status).toBe('queued');
    expect(accepted.body.data.import.totalRows).toBe(4);

    expect(await drain()).toBe(1);

    const report = await request(API)
      .get(`/orgs/${t.orgId}/contacts/imports/${importId}`)
      .set('Authorization', t.owner.auth);
    expect(report.status).toBe(200);
    expect(report.body.data.import.status).toBe('done');
    expect(report.body.data.import.importedCount).toBe(2);
    expect(report.body.data.import.skippedCount).toBe(2);
    expect(report.body.data.skippedTruncated).toBe(false);
    expect(
      report.body.data.skippedRows.map((r: { skipReason: string }) => r.skipReason).sort(),
    ).toEqual(['invalid_phone', 'missing_consent']);

    const contacts = await request(API)
      .get(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth);
    const phones = contacts.body.data.contacts.map((c: { phoneE164: string }) => c.phoneE164);
    expect(phones).toContain(good);
    expect(phones).toContain(optedOut);
    // The row with no provenance is NOT in the audience. Importing it without consent would look
    // exactly like the import working, and leave a person in a list they never joined.
    expect(phones).not.toContain(noConsent);

    // Consent went through the versioned, append-only path — not a column written beside the contact.
    const imported = contacts.body.data.contacts.find(
      (c: { phoneE164: string }) => c.phoneE164 === good,
    );
    const consents = await request(API)
      .get(`/orgs/${t.orgId}/contacts/${imported.id}/consents`)
      .set('Authorization', t.owner.auth);
    expect(consents.body.data.consents).toHaveLength(1);
    expect(consents.body.data.consents[0]).toMatchObject({
      purpose: 'marketing',
      state: 'opted_in',
      source: 'web_form',
      // Attributed to whoever uploaded the file. A consent row nobody is named on is one nobody can
      // be asked about.
      recordedByUserId: t.owner.id,
    });

    // An opted-out row is not merely documented — it is on the suppression list, which is the thing
    // that actually stops a send.
    const suppressions = await request(API)
      .get(`/orgs/${t.orgId}/suppressions`)
      .set('Authorization', t.owner.auth);
    expect(
      suppressions.body.data.suppressions.some(
        (s: { externalId: string }) => s.externalId === optedOut.slice(1),
      ),
    ).toBe(true);

    // Tags and attributes from the file landed on the contact, so a segment can find these people.
    expect([...imported.tags].sort()).toEqual(['newsletter', 'vip']);
  });

  it('skips a row for someone already in the audience instead of overwriting them', async () => {
    const t = await createTenant();
    const phone = uniquePhone();

    const first = await request(API)
      .post(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth)
      .send({ phoneE164: phone, displayName: 'Corrected By Hand' });
    expect(first.status).toBe(201);

    const accepted = await upload(t.orgId, t.owner.auth, `${HEADER}\n${row(phone, 'Stale Export')}\n`);
    expect(accepted.status).toBe(202);
    await drain();

    const report = await request(API)
      .get(`/orgs/${t.orgId}/contacts/imports/${accepted.body.data.import.id}`)
      .set('Authorization', t.owner.auth);
    expect(report.body.data.import.importedCount).toBe(0);
    expect(report.body.data.skippedRows[0].skipReason).toBe('already_a_contact');

    // The name an operator typed survives a stale spreadsheet. An import that overwrote it would do
    // so silently, with nothing anywhere to show what the name used to be.
    const after = await request(API)
      .get(`/orgs/${t.orgId}/contacts/${first.body.data.contact.id}`)
      .set('Authorization', t.owner.auth);
    expect(after.body.data.contact.displayName).toBe('Corrected By Hand');
  });

  it('resumes rather than restarting, and imports nobody twice', async () => {
    const t = await createTenant();
    const phones = Array.from({ length: 3 }, () => uniquePhone());
    const csv = `${HEADER}\n${phones.map((p) => row(p)).join('\n')}\n`;

    const accepted = await upload(t.orgId, t.owner.auth, csv);
    const importId = accepted.body.data.import.id;

    // Simulate a worker that died half way: row 1's outcome is already in the ledger, its contact
    // already exists. A handler that started over would meet its own work as a conflict.
    const created = await request(API)
      .post(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth)
      .send({ phoneE164: phones[0] });
    await db
      .insertInto('commerce_contact_import_rows')
      .values({
        import_id: importId,
        row_number: 1,
        raw_phone: phones[0] ?? '',
        contact_id: created.body.data.contact.id,
        imported: true,
      })
      .execute();

    await drain();

    const report = await request(API)
      .get(`/orgs/${t.orgId}/contacts/imports/${importId}`)
      .set('Authorization', t.owner.auth);
    expect(report.body.data.import.status).toBe('done');
    // Three rows, three outcomes, and the one that was already settled was left alone rather than
    // re-decided as `already_a_contact`.
    expect(report.body.data.import.importedCount).toBe(3);
    expect(report.body.data.import.skippedCount).toBe(0);

    const contacts = await request(API)
      .get(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth);
    expect(contacts.body.data.contacts).toHaveLength(3);
  });

  it('is a no-op when the same job is handled a second time', async () => {
    const t = await createTenant();
    const accepted = await upload(t.orgId, t.owner.auth, `${HEADER}\n${row(uniquePhone())}\n`);
    await drain();

    // A job the queue re-delivered after the import already finished. It must not re-walk the file
    // and it must not fail — there is nothing wrong, it is simply already done.
    const replay = await jobRepository.enqueue({
      orgId: t.orgId,
      kind: 'contact_import',
      payload: { importId: accepted.body.data.import.id },
    });
    if (replay === null) throw new Error('expected a job');
    expect((await contactImportHandler.handle(replay)).kind).toBe('done');

    const contacts = await request(API)
      .get(`/orgs/${t.orgId}/contacts`)
      .set('Authorization', t.owner.auth);
    expect(contacts.body.data.contacts).toHaveLength(1);
  });

  it('refuses a file whose header is wrong, at the door, before anything is stored', async () => {
    const t = await createTenant();

    const res = await upload(t.orgId, t.owner.auth, 'phone,name\n+442079460099,Someone\n');
    expect(res.status).toBe(400);

    // Nothing was queued and nothing was recorded — a rejected file leaves no half-import behind for
    // someone to find later and wonder about.
    const imports = await request(API)
      .get(`/orgs/${t.orgId}/contacts/imports`)
      .set('Authorization', t.owner.auth);
    expect(imports.body.data.imports).toHaveLength(0);
  });

  it('refuses a file that is not a CSV', async () => {
    const t = await createTenant();
    const res = await request(API)
      .post(`/orgs/${t.orgId}/contacts/import`)
      .set('Authorization', t.owner.auth)
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'list.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('refuses an upload with no file rather than answering 500', async () => {
    const t = await createTenant();
    const res = await request(API)
      .post(`/orgs/${t.orgId}/contacts/import`)
      .set('Authorization', t.owner.auth)
      .field('platform', 'whatsapp_cloud');
    expect(res.status).toBe(400);
  });

  it('lets an agent read the reports but not upload a list', async () => {
    const t = await createTenant();
    const agent = await addMember(t.orgId, 'agent');

    expect(
      (
        await request(API)
          .get(`/orgs/${t.orgId}/contacts/imports`)
          .set('Authorization', agent.auth)
      ).status,
    ).toBe(200);

    // Asserting that several hundred people agreed to be messaged is not a step in answering an
    // inbox message.
    const res = await upload(t.orgId, agent.auth, `${HEADER}\n${row(uniquePhone())}\n`);
    expect(res.status).toBe(403);
  });

  it('does not let a member of one org import into another', async () => {
    const a = await createTenant();
    const b = await createTenant();

    const res = await upload(b.orgId, a.owner.auth, `${HEADER}\n${row(uniquePhone())}\n`);
    // 404, not 403: a 403 confirms the org id exists, turning an id that appears in invite links
    // into an enumeration oracle.
    expect(res.status).toBe(404);
  });

  it('will not run an import against the wrong organization even if a job says to', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const accepted = await upload(a.orgId, a.owner.auth, `${HEADER}\n${row(uniquePhone())}\n`);

    // The only way this job could exist is a bug in an enqueuer, and the failure mode is the worst
    // one this plane has: one client's list written into another's audience.
    const crossing = await jobRepository.enqueue({
      orgId: b.orgId,
      kind: 'contact_import',
      payload: { importId: accepted.body.data.import.id },
    });
    if (crossing === null) throw new Error('expected a job');
    const outcome = await contactImportHandler.handle(crossing);
    expect(outcome.kind).toBe('failed');

    const contacts = await request(API)
      .get(`/orgs/${b.orgId}/contacts`)
      .set('Authorization', b.owner.auth);
    expect(contacts.body.data.contacts).toHaveLength(0);
  });
});
