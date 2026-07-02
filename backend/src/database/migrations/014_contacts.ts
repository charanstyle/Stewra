import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // A directed contact edge. Accepting an invite writes one row in each direction so "is a contact"
  // is a fast symmetric lookup. `status='blocked'` is a one-way suppression the owner sets. Being
  // (unblocked) contacts is the gate for starting a 1:1 conversation or a call.
  await db.schema
    .createTable('contacts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('owner_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('contact_user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('status', 'varchar(16)', (col) =>
      col.notNull().defaultTo('active').check(sql`status in ('active', 'blocked')`),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_contacts_owner_contact', ['owner_id', 'contact_user_id'])
    .execute();

  await db.schema.createIndex('idx_contacts_owner').on('contacts').column('owner_id').execute();

  // An invitation to connect, addressed to an email. If that email already belongs to a user,
  // `invitee_user_id` is resolved so the invite appears in their received list. `token` is the opaque
  // secret carried in the invite link (never exposed in API models).
  await db.schema
    .createTable('contact_invites')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('inviter_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('invitee_email', 'text', (col) => col.notNull())
    .addColumn('invitee_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('status', 'varchar(16)', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(sql`status in ('pending', 'accepted', 'declined', 'revoked')`),
    )
    .addColumn('token', 'varchar(64)', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('responded_at', 'timestamptz')
    .execute();

  await db.schema
    .createIndex('idx_contact_invites_inviter')
    .on('contact_invites')
    .column('inviter_id')
    .execute();
  await db.schema
    .createIndex('idx_contact_invites_invitee_user')
    .on('contact_invites')
    .column('invitee_user_id')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('contact_invites').execute();
  await db.schema.dropTable('contacts').execute();
}
