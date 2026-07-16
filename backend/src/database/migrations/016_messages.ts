import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // One row per message. `sender_id` is null for assistant turns (sender_kind='assistant'); non-null
  // for humans. `message_type` spans text, media, the Stewra-voice extensions ('voice' = a spoken turn
  // carrying both transcript and audio), and the synthetic 'call_start'/'call_end'/'system' markers that
  // render call history inline. `audio_url`/`transcript` back the heard-and-read assistant reply.
  // `delivered_at` is the coarse first-delivery stamp (RankRise 089 pattern); per-recipient read state
  // lives in message_read_receipts (migration 017).
  await db.schema
    .createTable('messages')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('conversation_id', 'uuid', (col) =>
      col.notNull().references('conversations.id').onDelete('cascade'),
    )
    // Null ONLY for assistant turns. onDelete('set null') keeps history readable after a user is neutralized.
    .addColumn('sender_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('sender_kind', 'varchar(16)', (col) =>
      col.notNull().defaultTo('user').check(sql`sender_kind in ('user', 'assistant')`),
    )
    .addColumn('message_type', 'varchar(16)', (col) =>
      col
        .notNull()
        .defaultTo('text')
        .check(
          sql`message_type in ('text', 'image', 'video', 'audio', 'voice', 'call_start', 'call_end', 'system')`,
        ),
    )
    .addColumn('content', 'text')
    .addColumn('media_url', 'text')
    .addColumn('media_type', 'varchar(32)')
    .addColumn('media_duration_sec', 'integer')
    .addColumn('thumbnail_url', 'text')
    // Stewra-voice: the spoken audio clip (user's recording or Piper TTS output) and its transcript.
    .addColumn('audio_url', 'text')
    .addColumn('transcript', 'text')
    // Minimized structured context (e.g. call_id for call markers); never raw records or secrets.
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('reply_to_message_id', 'uuid', (col) =>
      col.references('messages.id').onDelete('set null'),
    )
    .addColumn('is_edited', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('is_deleted', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('delivered_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // The hot path: list a conversation's messages newest-first with cursor pagination.
  await db.schema
    .createIndex('idx_messages_conversation_created')
    .on('messages')
    .columns(['conversation_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('messages').execute();
}
