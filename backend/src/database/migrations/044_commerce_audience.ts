import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The audience layer: what an organization knows about a contact, and how it names a group of them.
 *
 * A broadcast needs an answer to "who is this going to", and until now the only answer available was
 * "everyone who has ever messaged us" — which is not a campaign, it is a mailing list with no
 * memory. Three things are added, in increasing order of how much they can go wrong:
 *
 *   `commerce_contacts.attributes` — the client's own fields on a contact (plan, city, order value).
 *   `commerce_tags` + `commerce_contact_tags` — hand-applied labels.
 *   `commerce_segments` — a saved RULE that selects contacts, evaluated when it is used.
 *
 * A segment stores a rule, never a member list. A materialized list is a photograph of consent taken
 * at a moment nobody remembers: someone who opted out on Tuesday is still in Monday's snapshot, and
 * the send that used it was authorized by a fact that had already stopped being true. Storing the
 * rule means the audience is recomputed against current consent every single time, which is the only
 * version that stays correct without anyone maintaining it.
 *
 * The rule is a typed tree in jsonb, NOT a SQL fragment. Only members can write one, so this is not
 * primarily about injection — it is that a stored SQL string can never be re-validated, re-indexed,
 * migrated, or explained back to the person in the UI who wrote it. A tree can be all four.
 * `commerce/services/segmentQuery.ts` is the only thing that turns it into SQL.
 *
 * Note what is deliberately NOT expressible as a rule: suppression. There is no `suppressed = false`
 * predicate, because the send path applies the suppression list unconditionally to every recipient
 * regardless of how they were selected. A rule that could mention suppression is a rule that could
 * invert it.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // The client's own fields on a contact, as a flat JSON object of scalars. Flat rather than nested
  // because every rule that can be written against it is `attributes->>'key' <op> value`, and a
  // nested document would advertise a depth the segment compiler cannot actually query.
  await db.schema
    .alterTable('commerce_contacts')
    .addColumn('attributes', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute();

  // Same reasoning as `commerce_jobs.payload`: refuse a non-object at the column so the writer that
  // sent an array fails on its own INSERT, rather than a segment query later returning nothing and
  // looking like an empty audience.
  await db.schema
    .alterTable('commerce_contacts')
    .addCheckConstraint(
      'ck_commerce_contacts_attributes_object',
      sql`jsonb_typeof(attributes) = 'object'`,
    )
    .execute();

  // A contact row was previously write-once apart from the platform-reported name. It is now edited
  // by people, so when it last changed is a question someone will ask.
  await db.schema
    .alterTable('commerce_contacts')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Containment index for `attributes @> '{"plan":"pro"}'`. GIN with `jsonb_path_ops` would be
  // smaller and faster, but only supports containment; the default operator class also covers the
  // key-existence checks the `exists` rule uses.
  await sql`
    CREATE INDEX idx_commerce_contacts_attributes
    ON commerce_contacts USING gin (attributes)
  `.execute(db);

  await db.schema
    .createTable('commerce_tags')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(64)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Unique on the LOWERCASED name. "VIP" and "vip" arriving as two tags splits an audience in half
  // silently — the segment matches one of them, the campaign reaches half the people it named, and
  // nothing anywhere reports an error. Case is preserved for display; identity ignores it.
  await sql`
    CREATE UNIQUE INDEX uq_commerce_tags_org_name
    ON commerce_tags (org_id, lower(name))
  `.execute(db);

  await db.schema
    .createTable('commerce_contact_tags')
    .addColumn('contact_id', 'uuid', (col) =>
      col.notNull().references('commerce_contacts.id').onDelete('cascade'),
    )
    .addColumn('tag_id', 'uuid', (col) =>
      col.notNull().references('commerce_tags.id').onDelete('cascade'),
    )
    // Denormalized so a tenant filter on the join table is a single-table predicate, exactly as on
    // `commerce_messages`. The scope key must never be one join away from being forgotten.
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('pk_commerce_contact_tags', ['contact_id', 'tag_id'])
    .execute();

  // The reverse lookup: "who has this tag" — the direction every segment rule reads in.
  await db.schema
    .createIndex('idx_commerce_contact_tags_tag')
    .on('commerce_contact_tags')
    .columns(['tag_id', 'contact_id'])
    .execute();

  await db.schema
    .createTable('commerce_segments')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    .addColumn('description', 'text')
    // The rule tree: `{ match: 'all' | 'any', rules: [...] }`. Validated by zod on the way in and
    // again on the way out — a definition written under an older shape must fail loudly when it is
    // next used, not quietly select the wrong people.
    .addColumn('definition', 'jsonb', (col) =>
      col.notNull().check(sql`jsonb_typeof(definition) = 'object'`),
    )
    // Who wrote it. ON DELETE SET NULL: removing a member must not delete the segment their campaigns
    // are still pointed at.
    .addColumn('created_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Same case-insensitive rule as tags, for the same reason: two segments called "Lapsed" and
  // "lapsed" is a campaign sent to the wrong one.
  await sql`
    CREATE UNIQUE INDEX uq_commerce_segments_org_name
    ON commerce_segments (org_id, lower(name))
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_segments').ifExists().execute();
  await db.schema.dropTable('commerce_contact_tags').ifExists().execute();
  await db.schema.dropTable('commerce_tags').ifExists().execute();
  await sql`DROP INDEX IF EXISTS idx_commerce_contacts_attributes`.execute(db);
  await db.schema
    .alterTable('commerce_contacts')
    .dropConstraint('ck_commerce_contacts_attributes_object')
    .execute();
  await db.schema.alterTable('commerce_contacts').dropColumn('updated_at').execute();
  await db.schema.alterTable('commerce_contacts').dropColumn('attributes').execute();
}
