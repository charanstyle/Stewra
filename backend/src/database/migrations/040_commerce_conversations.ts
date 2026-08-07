import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The commerce inbox: an organization's threads with members of the public.
 *
 * Deliberately NOT the existing `conversations`/`messages` tables (migrations 015/016). Those model
 * chat between two Stewra accounts, are keyed on `created_by` plus a participant join, and carry no
 * channel provenance at all — you cannot tell from a `messages` row which transport it arrived on.
 * A commerce thread is org ↔ non-user, always on a named platform, and needs a service-window clock.
 * Overloading the existing tables would mean widening every personal-assistant query with a tenant
 * filter it has no reason to have.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // A person an organization is talking to. Not a Stewra account: no login, no reciprocity, no
  // `contacts` edge. They exist because they messaged a business or arrived from an ad.
  await db.schema
    .createTable('commerce_contacts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('platform', 'varchar(32)', (col) => col.notNull())
    // Meta's `wa_id` for WhatsApp — E.164 without the '+'.
    .addColumn('external_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('display_name', 'text')
    .addColumn('phone_e164', 'varchar(20)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // Scoped to the ORG, not globally: the same person may be a customer of two different clients,
    // and those must stay separate records. A global unique here would leak one client's customer
    // into another's inbox.
    .addUniqueConstraint('uq_commerce_contacts_org_platform_external', [
      'org_id',
      'platform',
      'external_id',
    ])
    .execute();

  await db.schema
    .createTable('commerce_conversations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('channel_account_id', 'uuid', (col) =>
      col.notNull().references('channel_accounts.id').onDelete('cascade'),
    )
    .addColumn('contact_id', 'uuid', (col) =>
      col.notNull().references('commerce_contacts.id').onDelete('cascade'),
    )
    .addColumn('platform', 'varchar(32)', (col) => col.notNull())
    .addColumn('last_message_at', 'timestamptz')
    // When the 24-hour customer-service window closes. Load-bearing, not decorative: outside it Meta
    // ACCEPTS a free-form send and then never delivers it, so an inbox that doesn't show this lets
    // agents write replies that vanish. Refreshed on every inbound message.
    .addColumn('service_window_expires_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // One thread per contact per connected number. A business with two numbers keeps two threads,
    // which is what its agents expect to see.
    .addUniqueConstraint('uq_commerce_conversations_account_contact', [
      'channel_account_id',
      'contact_id',
    ])
    .execute();

  // The inbox's default ordering — most recently active first, within a tenant.
  await db.schema
    .createIndex('idx_commerce_conversations_org_last_message')
    .on('commerce_conversations')
    .columns(['org_id', 'last_message_at'])
    .execute();

  await db.schema
    .createTable('commerce_messages')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // Denormalized from the conversation so every tenant filter is a single-table predicate. The
    // scope key must never require a join to apply — that is how a filter gets forgotten.
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('conversation_id', 'uuid', (col) =>
      col.notNull().references('commerce_conversations.id').onDelete('cascade'),
    )
    .addColumn('direction', 'varchar(8)', (col) =>
      col.notNull().check(sql`direction in ('inbound', 'outbound')`),
    )
    .addColumn('platform', 'varchar(32)', (col) => col.notNull())
    // NULL while an outbound send is still queued; set to the `wamid...` once the platform accepts.
    .addColumn('provider_message_id', 'varchar(255)')
    .addColumn('body', 'text', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) =>
      col
        .notNull()
        .defaultTo('queued')
        .check(sql`status in ('queued', 'sent', 'delivered', 'read', 'failed')`),
    )
    .addColumn('failure_reason', 'text')
    // Which member sent it. NULL for inbound and for automated sends. ON DELETE SET NULL so removing
    // a member never destroys the customer's side of the conversation.
    .addColumn('sent_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_commerce_messages_conversation_created')
    .on('commerce_messages')
    .columns(['conversation_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_messages').execute();
  await db.schema.dropTable('commerce_conversations').execute();
  await db.schema.dropTable('commerce_contacts').execute();
}
