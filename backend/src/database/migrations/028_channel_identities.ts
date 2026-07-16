import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Messaging CHANNELS (how a user reaches Stewra) — deliberately separate from `connections` (which are
 * read-only DATA SOURCES like Google). Conflating the two would blur what a "connection" means; a
 * WhatsApp link grants Stewra no data, it's just another doorway into the user's Stewra-AI thread.
 *
 * Nothing here holds a credential. Stewra's WhatsApp Cloud API token is a single deploy-wide system-user
 * token in env (not per-user), so the vault stays for per-user secrets and these tables stay boring.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // The identity map: which external channel address belongs to which Stewra user. This is the ONLY
  // thing that turns an inbound webhook (which carries just a phone number) into an authenticated
  // userId — so a row here is a security assertion, minted solely by the verified link flow below.
  await db.schema
    .createTable('channel_identities')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('channel', 'varchar(32)', (col) => col.notNull())
    // The channel-side address. For WhatsApp this is Meta's `wa_id` — an E.164 phone number, no '+'.
    .addColumn('external_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // A given WhatsApp number resolves to exactly ONE Stewra user. Without this, two accounts could claim
  // the same number and an inbound message would be ambiguous — i.e. an impersonation vector.
  await db.schema
    .createIndex('idx_channel_identities_channel_external')
    .on('channel_identities')
    .columns(['channel', 'external_id'])
    .unique()
    .execute();

  // ...and one user links at most one number per channel (re-linking replaces). Keeps "who is Stewra
  // talking to" single-valued, which is what the reply path assumes.
  await db.schema
    .createIndex('idx_channel_identities_user_channel')
    .on('channel_identities')
    .columns(['user_id', 'channel'])
    .unique()
    .execute();

  // Short-lived, single-use codes that prove the person holding the phone is the person holding the
  // logged-in session. The user (authenticated) mints one, then sends it FROM their WhatsApp; seeing it
  // arrive on the webhook proves possession of both factors. Consumed codes are kept (not deleted) so
  // a replay is a visible no-op rather than a silent re-mint.
  await db.schema
    .createTable('channel_link_codes')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('channel', 'varchar(32)', (col) => col.notNull())
    .addColumn('code', 'varchar(32)', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('consumed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // The code is the lookup key from an UNAUTHENTICATED webhook, so it must be globally unambiguous.
  await db.schema
    .createIndex('idx_channel_link_codes_code')
    .on('channel_link_codes')
    .columns(['code'])
    .unique()
    .execute();

  // Meta retries a webhook for up to 7 DAYS until it gets a 200 — so redelivery is guaranteed, not
  // hypothetical. Without this table a retry would replay the user's message into the agent (and bill
  // us for a second reply). Insert-first on the unique index IS the idempotency lock.
  await db.schema
    .createTable('channel_inbound_messages')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('channel', 'varchar(32)', (col) => col.notNull())
    // Meta's `messages[].id` (the `wamid...`). Unique per message, stable across retries.
    .addColumn('provider_message_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_channel_inbound_channel_provider_msg')
    .on('channel_inbound_messages')
    .columns(['channel', 'provider_message_id'])
    .unique()
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('channel_inbound_messages').execute();
  await db.schema.dropTable('channel_link_codes').execute();
  await db.schema.dropTable('channel_identities').execute();
}
