import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * TENANCY for the commerce plane (see packages/shared-types/src/models/organization.ts).
 *
 * Every table before this one is scoped by `user_id`, because Stewra's personal-assistant side has
 * exactly one principal per row. The commerce plane cannot work that way: a client business is
 * operated by several people, outlives any one of them, and must never be able to see another
 * business's customers. So `org_id` becomes the scope key for everything under it, and `users` is
 * demoted to what it always was — an authentication identity, joined in through `org_members`.
 *
 * Nothing here holds a credential. Channel credentials arrive in migration 039 and live in the
 * vault; the only secret in this file is an invite token, and that is stored HASHED.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('organizations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (col) => col.notNull())
    // URL-safe handle. Unique across the install because it appears in paths and is how a user
    // disambiguates between their orgs in chat ("send it from acme") — an ambiguous handle would
    // make the conversational surface resolve the wrong tenant.
    .addColumn('slug', 'varchar(64)', (col) => col.notNull().unique())
    .addColumn('status', 'varchar(16)', (col) =>
      col.notNull().defaultTo('active').check(sql`status in ('active', 'suspended')`),
    )
    // Who created it. Kept for provenance only — it confers nothing; ownership lives in org_members
    // and is transferable, so a departing founder does not take the organization with them.
    .addColumn('created_by', 'uuid', (col) => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Membership: the ONLY join between an authenticated user and an organization's data. Every
  // commerce query resolves tenancy through this table, so a missing row is a hard denial rather
  // than an empty result — see requireOrgMember.
  await db.schema
    .createTable('org_members')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('role', 'varchar(16)', (col) =>
      col.notNull().check(sql`role in ('owner', 'admin', 'marketer', 'agent', 'viewer')`),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // One membership per person per org. Two rows would make "what is this user's role here"
    // ambiguous, and an authorization check that can return two answers is a vulnerability.
    .addUniqueConstraint('uq_org_members_org_user', ['org_id', 'user_id'])
    .execute();

  await db.schema.createIndex('idx_org_members_user').on('org_members').column('user_id').execute();
  await db.schema.createIndex('idx_org_members_org').on('org_members').column('org_id').execute();

  // An invitation addressed to an email. Shaped like `contact_invites` (migration 014) with one
  // deliberate difference: the token is stored as a SHA-256 hash, never in plaintext, following the
  // bridge and runner device tokens. An invite readable out of the database is a credential at rest,
  // and this one grants access to a business's entire customer list.
  await db.schema
    .createTable('org_invites')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('email', 'text', (col) => col.notNull())
    .addColumn('role', 'varchar(16)', (col) =>
      col.notNull().check(sql`role in ('owner', 'admin', 'marketer', 'agent', 'viewer')`),
    )
    .addColumn('status', 'varchar(16)', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(sql`status in ('pending', 'accepted', 'revoked', 'expired')`),
    )
    .addColumn('token_hash', 'char(64)', (col) => col.notNull())
    .addColumn('invited_by', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('accepted_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // The hash is the lookup key from an otherwise unauthenticated redemption, so it must be globally
  // unambiguous — the same reason `channel_link_codes.code` is unique.
  await db.schema
    .createIndex('idx_org_invites_token_hash')
    .on('org_invites')
    .column('token_hash')
    .unique()
    .execute();

  await db.schema.createIndex('idx_org_invites_org').on('org_invites').column('org_id').execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('org_invites').execute();
  await db.schema.dropTable('org_members').execute();
  await db.schema.dropTable('organizations').execute();
}
