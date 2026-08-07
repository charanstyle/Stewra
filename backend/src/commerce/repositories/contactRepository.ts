import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import type {
  CommerceContact,
  CommercePlatform,
  CommerceTag,
  ContactAttributes,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type { CommerceContactsTable } from '../../database/types.js';

type ContactRow = Selectable<CommerceContactsTable>;

/**
 * `attributes` is `jsonb`, which at the type level admits an array or a bare number. Migration 044
 * constrains the column to an object, so the else branch is unreachable — but a predicate costs
 * nothing and means the mapper's type matches what was actually checked rather than what was assumed.
 */
function toAttributes(value: unknown): ContactAttributes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const attributes: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    // Values are strings by contract (see `ContactAttributes`). Anything else in the column came from
    // outside this code path; skipping it keeps every rule's text comparison meaningful rather than
    // stringifying an object into something a client would then try to match on.
    if (typeof entry === 'string') attributes[key] = entry;
  }
  return attributes;
}

function toContact(row: ContactRow): CommerceContact {
  return {
    id: row.id,
    orgId: row.org_id,
    platform: row.platform,
    externalId: row.external_id,
    displayName: row.display_name,
    phoneE164: row.phone_e164,
    attributes: toAttributes(row.attributes),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** A contact and the tag names on it, which is how every list view wants it. */
export interface ContactWithTags {
  readonly contact: CommerceContact;
  readonly tags: readonly string[];
}

/**
 * Contacts and their labels. Every query is scoped by `org_id` — the same person may be a customer of
 * two different clients, and those are two unrelated rows that must never see each other.
 */
class ContactRepository {
  /**
   * List a tenant's contacts, newest first, with their tags.
   *
   * Tags come back through an aggregate on the join rather than a second round trip: a list of 200
   * contacts would otherwise be 201 queries, and the version of this that gets written under time
   * pressure is the one that does them in a loop.
   */
  async list(params: {
    orgId: string;
    limit: number;
    search?: string;
    tag?: string;
  }): Promise<ContactWithTags[]> {
    let query = db
      .selectFrom('commerce_contacts as c')
      .selectAll('c')
      .select((eb) =>
        eb
          .selectFrom('commerce_contact_tags as ct')
          .innerJoin('commerce_tags as t', 't.id', 'ct.tag_id')
          .select(sql<string[]>`coalesce(array_agg(t.name order by t.name), '{}')`.as('names'))
          .whereRef('ct.contact_id', '=', 'c.id')
          .as('tag_names'),
      )
      .where('c.org_id', '=', params.orgId)
      .orderBy('c.created_at', 'desc')
      .limit(params.limit);

    if (params.search !== undefined && params.search.trim() !== '') {
      const needle = params.search.trim();
      // Three columns, because an operator searching for someone has whichever of the three the
      // customer just quoted at them. `strpos` rather than ILIKE so a `%` typed into the search box
      // is a literal percent sign and not a wildcard that matches the entire tenant.
      query = query.where(
        sql<boolean>`strpos(lower(coalesce(c.display_name, '')), lower(${needle})) > 0
          or strpos(c.external_id, ${needle}) > 0
          or strpos(coalesce(c.phone_e164, ''), ${needle}) > 0`,
      );
    }

    if (params.tag !== undefined && params.tag.trim() !== '') {
      const tag = params.tag.trim();
      query = query.where(
        sql<boolean>`exists (
          select 1 from commerce_contact_tags ct
          join commerce_tags t on t.id = ct.tag_id
          where ct.contact_id = c.id and lower(t.name) = lower(${tag})
        )`,
      );
    }

    const rows = await query.execute();
    return rows.map((row) => ({
      contact: toContact(row),
      tags: row.tag_names ?? [],
    }));
  }

  /**
   * Create a contact the organization already knows about, rather than one that messaged in.
   *
   * Deliberately NOT an upsert, unlike `commerceInboxRepository.upsertContact` next door. That one
   * serves a webhook where the same person arriving twice is ordinary and merging is the only sane
   * answer. This one serves a person typing into a form or loading a file, where an existing row is
   * a fact they need told: silently merging would let an import overwrite a display name that an
   * operator had corrected by hand, with nothing anywhere to show it happened.
   *
   * Returns `created: false` and the existing id instead of throwing, so the caller can decide —
   * the form says "this contact already exists" and links to them, the importer counts a skip.
   */
  async create(params: {
    orgId: string;
    platform: CommercePlatform;
    externalId: string;
    displayName: string | null;
    phoneE164: string | null;
    attributes: ContactAttributes;
  }): Promise<{ id: string; created: boolean }> {
    const inserted = await db
      .insertInto('commerce_contacts')
      .values({
        org_id: params.orgId,
        platform: params.platform,
        external_id: params.externalId,
        display_name: params.displayName,
        phone_e164: params.phoneE164,
        attributes: JSON.stringify(params.attributes),
      })
      // The unique index is the check, not a prior SELECT: two operators adding the same number at
      // the same moment would both pass a pre-check, and one would still fail here.
      .onConflict((oc) => oc.columns(['org_id', 'platform', 'external_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted !== undefined) return { id: inserted.id, created: true };

    const existing = await db
      .selectFrom('commerce_contacts')
      .select('id')
      .where('org_id', '=', params.orgId)
      .where('platform', '=', params.platform)
      .where('external_id', '=', params.externalId)
      .executeTakeFirstOrThrow();
    return { id: existing.id, created: false };
  }

  async findById(orgId: string, contactId: string): Promise<ContactWithTags | null> {
    const row = await db
      .selectFrom('commerce_contacts as c')
      .selectAll('c')
      .select((eb) =>
        eb
          .selectFrom('commerce_contact_tags as ct')
          .innerJoin('commerce_tags as t', 't.id', 'ct.tag_id')
          .select(sql<string[]>`coalesce(array_agg(t.name order by t.name), '{}')`.as('names'))
          .whereRef('ct.contact_id', '=', 'c.id')
          .as('tag_names'),
      )
      .where('c.org_id', '=', orgId)
      .where('c.id', '=', contactId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return { contact: toContact(row), tags: row.tag_names ?? [] };
  }

  /**
   * Edit the display name and merge attribute changes.
   *
   * The merge happens in SQL (`attributes || patch`, minus the keys being cleared) rather than
   * read-modify-write in Node. Two operators editing different fields of the same contact at the same
   * time is ordinary, and a read-modify-write would let the second save silently discard the first's
   * field with nothing anywhere to notice.
   */
  async update(params: {
    orgId: string;
    contactId: string;
    /** `undefined` leaves the name alone; `null` clears it. Two different requests, two values. */
    displayName: string | null | undefined;
    setAttributes: ContactAttributes;
    removeAttributeKeys: readonly string[];
  }): Promise<boolean> {
    const merged = sql<string>`
      (coalesce(attributes, '{}'::jsonb) || ${JSON.stringify(params.setAttributes)}::jsonb)
      - ${sql.val(params.removeAttributeKeys)}::text[]
    `;
    const result = await db
      .updateTable('commerce_contacts')
      .set((eb) => ({
        attributes: merged,
        display_name:
          params.displayName === undefined ? eb.ref('display_name') : params.displayName,
        updated_at: new Date(),
      }))
      .where('org_id', '=', params.orgId)
      .where('id', '=', params.contactId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Find-or-create a tag by name, case-insensitively.
   *
   * The ON CONFLICT targets the expression index on `lower(name)`, so two operators typing "VIP" and
   * "vip" at the same moment land on one row rather than racing to create two that would then split
   * every audience built on it.
   */
  async upsertTag(orgId: string, name: string): Promise<CommerceTag> {
    const row = await db
      .insertInto('commerce_tags')
      .values({ org_id: orgId, name })
      .onConflict((oc) =>
        oc
          // The conflict target is the expression index from migration 044, written out in full —
          // `(org_id, lower(name))`. Naming the columns alone would target an index that does not
          // exist and fail at runtime with a message about no matching arbiter.
          .expression(sql`org_id, lower(name)`)
          // A no-op assignment rather than DO NOTHING, which returns no row for the caller to use.
          .doUpdateSet((eb) => ({ name: eb.ref('commerce_tags.name') })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return { id: row.id, orgId: row.org_id, name: row.name, contactCount: 0, createdAt: row.created_at.toISOString() };
  }

  /** Attach a tag. Idempotent — tagging an already-tagged contact is not an error worth raising. */
  async attachTag(orgId: string, contactId: string, tagId: string): Promise<void> {
    await db
      .insertInto('commerce_contact_tags')
      .values({ org_id: orgId, contact_id: contactId, tag_id: tagId })
      .onConflict((oc) => oc.columns(['contact_id', 'tag_id']).doNothing())
      .execute();
  }

  /** Returns false when the label was not on the contact, rather than pretending it removed one. */
  async detachTag(orgId: string, contactId: string, tagId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('commerce_contact_tags')
      .where('org_id', '=', orgId)
      .where('contact_id', '=', contactId)
      .where('tag_id', '=', tagId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /** Every label in the org with how many contacts carry it — the only reason anyone opens the page. */
  async listTags(orgId: string): Promise<CommerceTag[]> {
    const rows = await db
      .selectFrom('commerce_tags as t')
      .leftJoin('commerce_contact_tags as ct', 'ct.tag_id', 't.id')
      .select(['t.id', 't.org_id', 't.name', 't.created_at'])
      .select(sql<string>`count(ct.contact_id)`.as('contact_count'))
      .where('t.org_id', '=', orgId)
      .groupBy(['t.id', 't.org_id', 't.name', 't.created_at'])
      .orderBy('t.name', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      contactCount: Number(row.contact_count),
      createdAt: row.created_at.toISOString(),
    }));
  }

  async findTagById(orgId: string, tagId: string): Promise<CommerceTag | null> {
    const row = await db
      .selectFrom('commerce_tags')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', tagId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      contactCount: 0,
      createdAt: row.created_at.toISOString(),
    };
  }

  async deleteTag(orgId: string, tagId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('commerce_tags')
      .where('org_id', '=', orgId)
      .where('id', '=', tagId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}

export const contactRepository = new ContactRepository();
