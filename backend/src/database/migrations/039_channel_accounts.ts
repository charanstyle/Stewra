import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * PER-TENANT messaging credentials — what replaces the deploy-wide `WHATSAPP_*` env vars for the
 * commerce plane.
 *
 * The personal-assistant channel (migration 028) could get away with a single system-user token in
 * env because there is one Stewra business number and every user messages it. A self-serve SaaS
 * inverts that: each client connects THEIR OWN WhatsApp Business Account, so the credential is
 * per-organization, rotates independently, and can be revoked by its owner at any time.
 *
 * The token itself is NOT in this table. It goes in the vault (migration 004) and is referenced here
 * by opaque handle, exactly as OAuth refresh tokens are — so a dump of this table yields no ability
 * to send as anybody.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('channel_accounts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('platform', 'varchar(32)', (col) =>
      col.notNull().check(sql`platform in ('whatsapp_cloud', 'instagram', 'messenger')`),
    )
    // The platform's own account id — a WABA id for WhatsApp. This is the key an inbound webhook is
    // routed by: Meta delivers every tenant's traffic to one URL, and `entry[].id` is the only thing
    // in the payload that says which business it belongs to.
    .addColumn('external_account_id', 'varchar(64)', (col) => col.notNull())
    // The sending identity under that account (WhatsApp's phone_number_id). NULL on platforms where
    // the account itself is the sender.
    .addColumn('phone_number_id', 'varchar(64)')
    .addColumn('display_name', 'text', (col) => col.notNull().defaultTo(''))
    // → vault_secrets.id. No FK: the vault is addressed by opaque handle, and a dangling ref must
    // surface as a loud "credential missing" at send time rather than block the row from existing.
    .addColumn('credential_ref', 'uuid', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) =>
      col.notNull().defaultTo('active').check(sql`status in ('active', 'revoked', 'error')`),
    )
    // Why a broken channel is broken, in words, for the reconnect prompt. A channel that silently
    // stops sending is the failure this column exists to prevent.
    .addColumn('error_detail', 'text')
    .addColumn('meta', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('connected_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // A WABA belongs to exactly ONE organization. Without this, two tenants could claim the same
  // account and an inbound message would be ambiguous — the same impersonation vector that
  // `channel_identities`' unique index closes, one level up.
  await db.schema
    .createIndex('idx_channel_accounts_platform_external')
    .on('channel_accounts')
    .columns(['platform', 'external_account_id'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_channel_accounts_org')
    .on('channel_accounts')
    .column('org_id')
    .execute();

  // Meta retries a webhook for up to 7 days until it gets a 200, so redelivery is guaranteed rather
  // than hypothetical. Insert-first against the unique index IS the idempotency lock — the same
  // mechanism as `channel_inbound_messages` (028), kept separate because that table's `channel` is a
  // MessagingChannel and these are CommercePlatforms.
  await db.schema
    .createTable('commerce_inbound_messages')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('platform', 'varchar(32)', (col) => col.notNull())
    .addColumn('provider_message_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_commerce_inbound_platform_provider_msg')
    .on('commerce_inbound_messages')
    .columns(['platform', 'provider_message_id'])
    .unique()
    .execute();

  // Which organization this user's CONVERSATIONAL turns act on. The WhatsApp command surface has no
  // route param and no header to carry a tenant — without a stored answer it cannot resolve one at
  // all.
  //
  // Its own table rather than a column on `user_preferences`: that table belongs to the
  // personal-assistant plane (Gmail lookback, sent-mail learning, WhatsApp email opt-in), and the
  // commerce context does not write to personal-assistant tables. Keeping it separate also avoids
  // having to supply that table's NOT NULL `gmail_lookback_days` just to record an org choice.
  //
  // ON DELETE CASCADE on the org, so leaving or deleting an organization degrades to "pick one"
  // rather than leaving a dangling scope behind.
  await db.schema
    .createTable('commerce_active_orgs')
    .addColumn('user_id', 'uuid', (col) =>
      col.primaryKey().references('users.id').onDelete('cascade'),
    )
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_active_orgs').execute();
  await db.schema.dropTable('commerce_inbound_messages').execute();
  await db.schema.dropTable('channel_accounts').execute();
}
