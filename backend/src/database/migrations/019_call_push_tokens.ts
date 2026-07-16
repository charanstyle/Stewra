import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // Push routing for background ringing. iOS registers a PushKit `voip_token` (APNs VoIP); Android
  // registers an `fcm_token` (data push → foreground service). One row per (user, platform) — a new
  // registration for the same platform upserts the token. Ringing degrades to in-app when no row exists.
  await db.schema
    .createTable('call_push_tokens')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('platform', 'varchar(16)', (col) =>
      col.notNull().check(sql`platform in ('ios', 'android')`),
    )
    .addColumn('voip_token', 'text')
    .addColumn('fcm_token', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_call_push_user_platform', ['user_id', 'platform'])
    .execute();

  await db.schema
    .createIndex('idx_call_push_tokens_user')
    .on('call_push_tokens')
    .column('user_id')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('call_push_tokens').execute();
}
