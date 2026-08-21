import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { sql } from 'kysely';
import type { SegmentDefinition } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { db, closeDb } from '../database/index.js';
import { errorHandler } from '../middleware/errorHandler.js';
import orgRoutes from '../tenancy/routes/organizations.js';
import commerceOrgRoutes from '../commerce/routes/orgSurface.js';
import { organizationRepository } from '../tenancy/repositories/organizationRepository.js';
import { contactRepository } from '../commerce/repositories/contactRepository.js';
import { segmentRepository } from '../commerce/repositories/segmentRepository.js';
import { audienceService } from '../commerce/services/audienceService.js';

/**
 * AUDIENCE. Who a campaign is about to reach, and who it must not.
 *
 * The property every test here defends is that a segment is a RULE, not a stored member list — so the
 * audience is recomputed against consent as it stands at the moment of asking. A materialized list is
 * a photograph of permission taken at a time nobody remembers; someone who opted out on Tuesday is
 * still in Monday's snapshot, and the send that used it was authorized by a fact that had already
 * stopped being true.
 *
 * Real Postgres, the real router, the real requireAuth → requireEmailVerification → requireOrgMember
 * chain. Nothing is stood in for, and that matters more than usual here: every rule in this feature is
 * SQL, and a mocked `db` would assert that a query was built while saying nothing about whether it
 * selects the right people.
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
      email: `commerce-segments-${randomUUID()}@stewra.invalid`,
      display_name: 'Commerce Segments Test User',
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
  readonly channelAccountId: string;
}

async function createTenant(): Promise<Tenant> {
  const owner = await createUser();
  const { org } = await organizationRepository.create({
    name: 'Audience Test Co',
    slug: `audience-${randomUUID().slice(0, 8)}`,
    createdBy: owner.id,
  });
  createdOrgs.push(org.id);

  const account = await db
    .insertInto('channel_accounts')
    .values({
      org_id: org.id,
      platform: 'whatsapp_cloud',
      external_account_id: `waba-${randomUUID()}`,
      phone_number_id: `pn-${randomUUID().slice(0, 8)}`,
      credential_ref: randomUUID(),
      meta: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { owner, orgId: org.id, channelAccountId: account.id };
}

interface ContactSpec {
  readonly displayName?: string;
  readonly platform?: 'whatsapp_cloud' | 'instagram' | 'messenger';
  readonly attributes?: Record<string, string>;
  readonly tags?: readonly string[];
  readonly marketing?: 'opted_in' | 'opted_out';
  readonly suppressed?: boolean;
  readonly createdAt?: Date;
  readonly lastMessageAt?: Date | null;
}

interface TestContact {
  readonly id: string;
  readonly externalId: string;
}

/** One contact with every fixture concern — tags, attributes, consent, suppression — already applied. */
async function addContact(t: Tenant, spec: ContactSpec): Promise<TestContact> {
  const externalId = `4477${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const platform = spec.platform ?? 'whatsapp_cloud';
  const contact = await db
    .insertInto('commerce_contacts')
    .values({
      org_id: t.orgId,
      platform,
      external_id: externalId,
      display_name: spec.displayName ?? 'Audience Contact',
      phone_e164: `+${externalId}`,
      attributes: JSON.stringify(spec.attributes ?? {}),
      ...(spec.createdAt === undefined ? {} : { created_at: spec.createdAt }),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  for (const tag of spec.tags ?? []) {
    const row = await contactRepository.upsertTag(t.orgId, tag);
    await contactRepository.attachTag(t.orgId, contact.id, row.id);
  }

  if (spec.marketing !== undefined) {
    await db
      .insertInto('commerce_contact_consents')
      .values({
        org_id: t.orgId,
        contact_id: contact.id,
        platform,
        purpose: 'marketing',
        state: spec.marketing,
        source: 'web_form',
        evidence: 'https://example.invalid/signup',
      })
      .execute();
  }

  if (spec.suppressed === true) {
    await db
      .insertInto('commerce_suppressions')
      .values({
        org_id: t.orgId,
        platform,
        external_id: externalId,
        reason: 'opt_out',
      })
      .execute();
  }

  if (spec.lastMessageAt !== undefined) {
    await db
      .insertInto('commerce_conversations')
      .values({
        org_id: t.orgId,
        channel_account_id: t.channelAccountId,
        contact_id: contact.id,
        platform,
        last_message_at: spec.lastMessageAt,
      })
      .execute();
  }

  return { id: contact.id, externalId };
}

function rule(...rules: SegmentDefinition['rules']): SegmentDefinition {
  return { match: 'all', rules };
}

/** Contact ids the definition selects, regardless of whether they can be messaged. */
async function selected(orgId: string, definition: SegmentDefinition): Promise<Set<string>> {
  const members = await segmentRepository.listAudience({
    orgId,
    definition,
    limit: 500,
    offset: 0,
    sendableOnly: false,
  });
  return new Set(members.map((member) => member.contactId));
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    await db.deleteFrom('commerce_segments').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_contact_tags').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_tags').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_conversations').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_messaging_policies').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_suppressions').where('org_id', 'in', createdOrgs).execute();
    await dropConsentRows(createdOrgs);
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
        not(
          exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id')),
        ),
      )
      .execute();
  }
  await closeDb();
});

/**
 * The consent trail is append-only by trigger, including against DELETE, so fixture rows have to be
 * dropped with it momentarily off — inside one transaction, which holds an ACCESS EXCLUSIVE lock so
 * no other session can observe the gap. Same approach as `commerceConsent.test.ts`; the alternative
 * is this suite's rows accumulating in `stewra_test` forever.
 */
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

describe('a rule selects the people it says it selects', () => {
  it('matches a tag by name, case-insensitively, and its negation includes the untagged', async () => {
    const t = await createTenant();
    const vip = await addContact(t, { tags: ['VIP'] });
    const plain = await addContact(t, {});

    const has = await selected(t.orgId, rule({ type: 'tag', op: 'has', tag: 'vip' }));
    expect(has).toEqual(new Set([vip.id]));

    const notHas = await selected(t.orgId, rule({ type: 'tag', op: 'not_has', tag: 'VIP' }));
    expect(notHas).toEqual(new Set([plain.id]));
  });

  it('compares attributes as text, and `neq` keeps a contact who has no such field at all', async () => {
    const t = await createTenant();
    const pro = await addContact(t, { attributes: { plan: 'pro' } });
    const free = await addContact(t, { attributes: { plan: 'free' } });
    const unknown = await addContact(t, {});

    expect(
      await selected(t.orgId, rule({ type: 'attribute', key: 'plan', op: 'eq', value: 'pro' })),
    ).toEqual(new Set([pro.id]));

    // The whole reason `neq` is IS DISTINCT FROM: `plan <> 'pro'` against a missing key is NULL, which
    // is not TRUE, and the contact nobody has classified yet would silently vanish from "not pro".
    expect(
      await selected(t.orgId, rule({ type: 'attribute', key: 'plan', op: 'neq', value: 'pro' })),
    ).toEqual(new Set([free.id, unknown.id]));

    expect(
      await selected(t.orgId, rule({ type: 'attribute', key: 'plan', op: 'exists' })),
    ).toEqual(new Set([pro.id, free.id]));

    expect(
      await selected(t.orgId, rule({ type: 'attribute', key: 'plan', op: 'not_exists' })),
    ).toEqual(new Set([unknown.id]));
  });

  it('treats % in a contains value as a literal percent sign, not a wildcard', async () => {
    const t = await createTenant();
    const literal = await addContact(t, { attributes: { note: 'saved 20% at checkout' } });
    await addContact(t, { attributes: { note: 'no discount' } });

    // Under ILIKE this needle would match every contact with a `note` at all. It must match one.
    const found = await selected(
      t.orgId,
      rule({ type: 'attribute', key: 'note', op: 'contains', value: '%' }),
    );
    expect(found).toEqual(new Set([literal.id]));
  });

  it('reads consent as the newest record, and tells "never asked" apart from "opted out"', async () => {
    const t = await createTenant();
    const inn = await addContact(t, { marketing: 'opted_in' });
    const out = await addContact(t, { marketing: 'opted_out' });
    const never = await addContact(t, {});

    expect(
      await selected(t.orgId, rule({ type: 'consent', purpose: 'marketing', state: 'opted_in' })),
    ).toEqual(new Set([inn.id]));
    expect(
      await selected(t.orgId, rule({ type: 'consent', purpose: 'marketing', state: 'opted_out' })),
    ).toEqual(new Set([out.id]));
    // The re-permission audience: people who were never asked, which is not the same population as
    // people who said no, and merging the two is how a campaign messages someone who declined.
    expect(
      await selected(t.orgId, rule({ type: 'consent', purpose: 'marketing', state: 'none' })),
    ).toEqual(new Set([never.id]));
  });

  it('follows an opt-out recorded after an opt-in, rather than the first answer on file', async () => {
    const t = await createTenant();
    const changed = await addContact(t, { marketing: 'opted_in' });
    await db
      .insertInto('commerce_contact_consents')
      .values({
        org_id: t.orgId,
        contact_id: changed.id,
        platform: 'whatsapp_cloud',
        purpose: 'marketing',
        state: 'opted_out',
        // `recorded_at` is the database's to write — the column is not insertable, deliberately, so
        // that an opt-out cannot be backdated. The two inserts are separate statements, so this row
        // is genuinely later than the opt-in above.
        source: 'keyword',
        evidence: 'STOP',
      })
      .execute();

    expect(
      await selected(t.orgId, rule({ type: 'consent', purpose: 'marketing', state: 'opted_in' })),
    ).toEqual(new Set());
    expect(
      await selected(t.orgId, rule({ type: 'consent', purpose: 'marketing', state: 'opted_out' })),
    ).toEqual(new Set([changed.id]));
  });

  it('separates never-messaged from messaged-long-ago', async () => {
    const t = await createTenant();
    const old = await addContact(t, { lastMessageAt: new Date('2020-01-01T00:00:00Z') });
    const recent = await addContact(t, { lastMessageAt: new Date('2030-01-01T00:00:00Z') });
    const never = await addContact(t, {});

    const cutoff = '2025-01-01T00:00:00.000Z';
    expect(
      await selected(t.orgId, rule({ type: 'last_message', op: 'before', value: cutoff })),
    ).toEqual(new Set([old.id]));
    expect(
      await selected(t.orgId, rule({ type: 'last_message', op: 'after', value: cutoff })),
    ).toEqual(new Set([recent.id]));
    // A contact who has never written is NOT "last messaged before 2025" — they have no last message.
    expect(await selected(t.orgId, rule({ type: 'last_message', op: 'never' }))).toEqual(
      new Set([never.id]),
    );
  });

  it('filters by platform and by creation date', async () => {
    const t = await createTenant();
    const wa = await addContact(t, { createdAt: new Date('2024-01-01T00:00:00Z') });
    const ig = await addContact(t, {
      platform: 'instagram',
      createdAt: new Date('2030-01-01T00:00:00Z'),
    });

    expect(
      await selected(t.orgId, rule({ type: 'platform', value: 'instagram' })),
    ).toEqual(new Set([ig.id]));
    expect(
      await selected(t.orgId, rule({ type: 'created', op: 'before', value: '2025-01-01T00:00:00.000Z' })),
    ).toEqual(new Set([wa.id]));
  });

  it('ANDs under `all` and ORs under `any`', async () => {
    const t = await createTenant();
    const both = await addContact(t, { tags: ['vip'], attributes: { plan: 'pro' } });
    const tagOnly = await addContact(t, { tags: ['vip'] });
    const attrOnly = await addContact(t, { attributes: { plan: 'pro' } });
    await addContact(t, {});

    const rules: SegmentDefinition['rules'] = [
      { type: 'tag', op: 'has', tag: 'vip' },
      { type: 'attribute', key: 'plan', op: 'eq', value: 'pro' },
    ];

    expect(await selected(t.orgId, { match: 'all', rules })).toEqual(new Set([both.id]));
    expect(await selected(t.orgId, { match: 'any', rules })).toEqual(
      new Set([both.id, tagOnly.id, attrOnly.id]),
    );
  });
});

describe('a segment never escapes its tenant', () => {
  it('does not select another organization\'s contacts, even on an identical rule', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const mine = await addContact(a, { tags: ['vip'] });
    await addContact(b, { tags: ['vip'] });

    expect(await selected(a.orgId, rule({ type: 'tag', op: 'has', tag: 'vip' }))).toEqual(
      new Set([mine.id]),
    );
  });

  it('refuses a member of another org the whole audience surface', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const segment = await audienceService.createSegment({
      orgId: a.orgId,
      name: 'Everyone in A',
      description: null,
      definition: rule({ type: 'attribute', key: 'plan', op: 'exists' }),
      createdByUserId: a.owner.id,
    });

    for (const path of [
      `/orgs/${a.orgId}/contacts`,
      `/orgs/${a.orgId}/tags`,
      `/orgs/${a.orgId}/segments`,
      `/orgs/${a.orgId}/segments/${segment.id}`,
      `/orgs/${a.orgId}/segments/${segment.id}/members`,
    ]) {
      const res = await request(API).get(path).set('Authorization', b.owner.auth);
      // 404 rather than 403, per requireOrgMember: 403 would confirm the org id is real, which is
      // all an attacker enumerating uuids needs. A non-member is told the org does not exist.
      expect(res.status).toBe(404);
    }
  });
});

describe('a rule-less segment is refused', () => {
  it('rejects an empty rule list rather than selecting everybody', async () => {
    const t = await createTenant();
    const res = await request(API)
      .post(`/orgs/${t.orgId}/segments`)
      .set('Authorization', t.owner.auth)
      .send({ name: 'Draft', definition: { match: 'all', rules: [] } });
    // "All of nothing" is TRUE in every boolean algebra, so an empty rule list would quietly mean the
    // entire contact list while looking like an unfinished draft.
    expect(res.status).toBe(400);
  });

  it('refuses to evaluate a stored definition this version cannot parse', async () => {
    const t = await createTenant();
    const row = await db
      .insertInto('commerce_segments')
      .values({
        org_id: t.orgId,
        name: 'Written by a future version',
        description: null,
        definition: JSON.stringify({ match: 'all', rules: [{ type: 'horoscope', sign: 'leo' }] }),
        created_by_user_id: t.owner.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Loudly, and naming the segment. The alternative — dropping the rule it cannot read — is a
    // campaign that silently selects a different, larger population than the one anyone approved.
    await expect(audienceService.getSegment(t.orgId, row.id)).rejects.toThrow(
      /cannot evaluate/i,
    );
  });
});

describe('the preview says who can actually be reached', () => {
  it('reports each block reason, in the order that decides what an operator does next', async () => {
    const t = await createTenant();
    await addContact(t, { tags: ['all'], marketing: 'opted_in' });
    await addContact(t, { tags: ['all'], marketing: 'opted_in', suppressed: true });
    await addContact(t, { tags: ['all'], marketing: 'opted_out' });
    await addContact(t, { tags: ['all'] });
    await addContact(t, { tags: ['all'], platform: 'instagram', marketing: 'opted_in' });

    const preview = await audienceService.previewSegment(
      t.orgId,
      rule({ type: 'tag', op: 'has', tag: 'all' }),
      20,
    );

    expect(preview.total).toBe(5);
    expect(preview.sendable).toBe(1);
    expect(preview.blocked).toEqual({
      suppressed: 1,
      marketing_opted_out: 1,
      no_marketing_consent: 1,
      platform_inbound_only: 1,
    });
    // No policy on this org yet, so nothing may go out whatever the per-contact numbers say.
    expect(preview.orgBlockedReason).toBe('no_messaging_policy');
  });

  it('reports a suppressed contact as suppressed even when consent is on file', async () => {
    const t = await createTenant();
    await addContact(t, { tags: ['x'], marketing: 'opted_in', suppressed: true });

    const preview = await audienceService.previewSegment(
      t.orgId,
      rule({ type: 'tag', op: 'has', tag: 'x' }),
      20,
    );
    // Precedence matters: calling this "no consent" would invite an operator to go and collect one,
    // when the block is the thing the person asked for themselves.
    expect(preview.blocked.suppressed).toBe(1);
    expect(preview.sample[0]?.blockedReason).toBe('suppressed');
  });

  it('drops the unreachable from the member list when asked for sendable only', async () => {
    const t = await createTenant();
    const reachable = await addContact(t, { tags: ['x'], marketing: 'opted_in' });
    await addContact(t, { tags: ['x'], marketing: 'opted_out' });

    const members = await segmentRepository.listAudience({
      orgId: t.orgId,
      definition: rule({ type: 'tag', op: 'has', tag: 'x' }),
      limit: 100,
      offset: 0,
      sendableOnly: true,
    });
    expect(members.map((member) => member.contactId)).toEqual([reachable.id]);
  });

  it('pages without repeating or skipping contacts that share a created_at', async () => {
    const t = await createTenant();
    const sameInstant = new Date('2026-03-03T12:00:00.000Z');
    for (let index = 0; index < 6; index += 1) {
      await addContact(t, { tags: ['batch'], createdAt: sameInstant });
    }

    const definition = rule({ type: 'tag', op: 'has', tag: 'batch' });
    const pages: string[] = [];
    for (const offset of [0, 2, 4]) {
      const page = await segmentRepository.listAudience({
        orgId: t.orgId,
        definition,
        limit: 2,
        offset,
        sendableOnly: false,
      });
      pages.push(...page.map((member) => member.contactId));
    }
    // An import writes a batch with identical timestamps; an unstable sort under OFFSET means some
    // people are messaged twice and others never.
    expect(new Set(pages).size).toBe(6);
  });
});

describe('tags stay one thing', () => {
  it('treats VIP and vip as the same label rather than splitting the audience', async () => {
    const t = await createTenant();
    const first = await contactRepository.upsertTag(t.orgId, 'VIP');
    const second = await contactRepository.upsertTag(t.orgId, 'vip');
    expect(second.id).toBe(first.id);
    // The first spelling wins; the conflict path must not rewrite it to the second.
    expect(second.name).toBe('VIP');
  });

  it('refuses to delete a tag a segment still names, and says which segments', async () => {
    const t = await createTenant();
    const tag = await contactRepository.upsertTag(t.orgId, 'lapsed');
    await audienceService.createSegment({
      orgId: t.orgId,
      name: 'Win-back',
      description: null,
      definition: rule({ type: 'tag', op: 'has', tag: 'Lapsed' }),
      createdByUserId: t.owner.id,
    });

    await expect(audienceService.deleteTag(t.orgId, tag.id)).rejects.toThrow(/Win-back/);
  });

  it('deletes a tag nothing references, and takes it off the contacts carrying it', async () => {
    const t = await createTenant();
    const contact = await addContact(t, { tags: ['seasonal'] });
    const tag = await contactRepository.upsertTag(t.orgId, 'seasonal');

    expect(await audienceService.deleteTag(t.orgId, tag.id)).toBe(true);
    const after = await contactRepository.findById(t.orgId, contact.id);
    expect(after?.tags).toEqual([]);
  });

  it('will not mint a tag against another organization\'s contact', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const theirs = await addContact(b, {});

    await expect(audienceService.addContactTag(a.orgId, theirs.id, 'poached')).rejects.toThrow(
      /not found/i,
    );
    expect(await contactRepository.listTags(a.orgId)).toEqual([]);
  });
});

describe('editing a contact merges rather than replaces', () => {
  it('keeps a field another operator added while this request was open', async () => {
    const t = await createTenant();
    const contact = await addContact(t, { attributes: { plan: 'pro' } });

    // The second operator's request never mentioned `plan`; a read-modify-write would drop it.
    await audienceService.updateContact({
      orgId: t.orgId,
      contactId: contact.id,
      displayName: undefined,
      attributes: { city: 'Leeds' },
    });
    const after = await audienceService.getContact(t.orgId, contact.id);
    expect(after.contact.attributes).toEqual({ plan: 'pro', city: 'Leeds' });
  });

  it('deletes a key on null and leaves the display name alone when it is absent', async () => {
    const t = await createTenant();
    const contact = await addContact(t, {
      displayName: 'Dana Okonkwo',
      attributes: { plan: 'pro', city: 'Leeds' },
    });

    const updated = await audienceService.updateContact({
      orgId: t.orgId,
      contactId: contact.id,
      displayName: undefined,
      attributes: { plan: null },
    });
    expect(updated.contact.attributes).toEqual({ city: 'Leeds' });
    expect(updated.contact.displayName).toBe('Dana Okonkwo');

    const cleared = await audienceService.updateContact({
      orgId: t.orgId,
      contactId: contact.id,
      displayName: null,
      attributes: undefined,
    });
    expect(cleared.contact.displayName).toBeNull();
  });

  it('refuses an attribute key no rule could ever reference', async () => {
    const t = await createTenant();
    const contact = await addContact(t, {});
    await expect(
      audienceService.updateContact({
        orgId: t.orgId,
        contactId: contact.id,
        displayName: undefined,
        attributes: { 'plan;drop': 'pro' },
      }),
    ).rejects.toThrow(/usable attribute name/i);
  });
});

describe('the HTTP surface', () => {
  it('previews an unsaved definition, and stores nothing while doing it', async () => {
    const t = await createTenant();
    await addContact(t, { tags: ['x'], marketing: 'opted_in' });

    const res = await request(API)
      .post(`/orgs/${t.orgId}/segments/preview`)
      .set('Authorization', t.owner.auth)
      .send({ definition: { match: 'all', rules: [{ type: 'tag', op: 'has', tag: 'x' }] } });

    expect(res.status).toBe(200);
    expect(res.body.data.preview.total).toBe(1);
    expect(await audienceService.listSegments(t.orgId)).toEqual([]);
  });

  it('refuses a second segment with the same name', async () => {
    const t = await createTenant();
    const body = {
      name: 'Lapsed',
      definition: { match: 'all', rules: [{ type: 'last_message', op: 'never' }] },
    };
    const first = await request(API)
      .post(`/orgs/${t.orgId}/segments`)
      .set('Authorization', t.owner.auth)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(API)
      .post(`/orgs/${t.orgId}/segments`)
      .set('Authorization', t.owner.auth)
      .send({ ...body, name: 'lapsed' });
    expect(second.status).toBe(409);
  });

  it('lets a viewer read the audience but not edit it', async () => {
    const t = await createTenant();
    const viewer = await createUser();
    await db
      .insertInto('org_members')
      .values({ org_id: t.orgId, user_id: viewer.id, role: 'viewer' })
      .execute();

    const read = await request(API)
      .get(`/orgs/${t.orgId}/segments`)
      .set('Authorization', viewer.auth);
    expect(read.status).toBe(200);

    const write = await request(API)
      .post(`/orgs/${t.orgId}/segments`)
      .set('Authorization', viewer.auth)
      .send({
        name: 'Viewer wrote this',
        definition: { match: 'all', rules: [{ type: 'last_message', op: 'never' }] },
      });
    expect(write.status).toBe(403);
  });

  it('reads sendableOnly=false as false rather than as a non-empty string', async () => {
    const t = await createTenant();
    await addContact(t, { tags: ['x'], marketing: 'opted_out' });
    const segment = await audienceService.createSegment({
      orgId: t.orgId,
      name: 'Tagged x',
      description: null,
      definition: rule({ type: 'tag', op: 'has', tag: 'x' }),
      createdByUserId: t.owner.id,
    });

    const res = await request(API)
      .get(`/orgs/${t.orgId}/segments/${segment.id}/members?sendableOnly=false`)
      .set('Authorization', t.owner.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.members).toHaveLength(1);
  });
});
