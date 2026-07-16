import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // General in-app push routing (Expo push) — distinct from `call_push_tokens`, which holds PushKit/FCM
  // VoIP tokens for the native call layer. This table holds an Expo push token (`expo_token`) used for
  // actionable notifications such as the approve-to-send email prompt. One row per (user, platform): a
  // re-register for the same platform upserts the token, so a reinstalled/rotated device never leaves a
  // stale token behind. Delivery simply no-ops when no row exists.
  await db.schema
    .createTable('push_tokens')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('platform', 'varchar(16)', (col) =>
      col.notNull().check(sql`platform in ('ios', 'android')`),
    )
    .addColumn('expo_token', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_push_tokens_user_platform', ['user_id', 'platform'])
    .execute();

  await db.schema
    .createIndex('idx_push_tokens_user')
    .on('push_tokens')
    .column('user_id')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('push_tokens').execute();
}
