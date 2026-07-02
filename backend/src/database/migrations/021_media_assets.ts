import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // One row per stored binary (voice recording in, Piper TTS out, image/video/audio attachment). Owner-
  // scoped so `GET /media/:id` can authorize (owner-or-conversation-participant) before streaming — audio
  // is as access-controlled as messages, never publicly served. `path` is relative to UPLOADS_DIR;
  // `bytes`/`mime` support quota + GC. `conversation_id` is null for assets not yet attached to a thread.
  await db.schema
    .createTable('media_assets')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('owner_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('conversation_id', 'uuid', (col) =>
      col.references('conversations.id').onDelete('set null'),
    )
    .addColumn('kind', 'varchar(16)', (col) =>
      col.notNull().check(sql`kind in ('voice_in', 'tts_out', 'image', 'video', 'audio', 'file')`),
    )
    .addColumn('path', 'text', (col) => col.notNull())
    .addColumn('mime', 'varchar(64)', (col) => col.notNull())
    .addColumn('bytes', 'bigint', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_media_assets_owner').on('media_assets').column('owner_id').execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('media_assets').execute();
}
