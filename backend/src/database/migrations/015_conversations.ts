import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // A conversation thread. `type='direct'` is a 1:1 between two contacts; `'group'` is many humans;
  // `'stewra_ai'` is the singleton assistant conversation (one per user — enforced by a partial unique
  // index in migration 020). The assistant is NOT a users row: its turns are messages with
  // sender_id=null, sender_kind='assistant'. `last_message_at` is denormalized for cheap inbox sorting.
  await db.schema
    .createTable('conversations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('type', 'varchar(16)', (col) =>
      col.notNull().check(sql`type in ('direct', 'group', 'stewra_ai')`),
    )
    .addColumn('title', 'text')
    .addColumn('avatar_url', 'text')
    .addColumn('created_by', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('last_message_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('is_archived', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Membership + per-user read state. `left_at IS NULL` means still a participant (the authorization
  // gate for reading/sending). `last_read_at` drives unread counts. Unique (conversation, user) so a
  // user appears at most once; re-joining a group clears `left_at` on the same row.
  await db.schema
    .createTable('conversation_participants')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('conversation_id', 'uuid', (col) =>
      col.notNull().references('conversations.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('role', 'varchar(16)', (col) =>
      col.notNull().defaultTo('member').check(sql`role in ('admin', 'member')`),
    )
    .addColumn('is_muted', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('last_read_at', 'timestamptz')
    .addColumn('joined_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('left_at', 'timestamptz')
    .addUniqueConstraint('uq_participant_conversation_user', ['conversation_id', 'user_id'])
    .execute();

  await db.schema
    .createIndex('idx_participants_user')
    .on('conversation_participants')
    .column('user_id')
    .execute();
  await db.schema
    .createIndex('idx_participants_conversation')
    .on('conversation_participants')
    .column('conversation_id')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('conversation_participants').execute();
  await db.schema.dropTable('conversations').execute();
}
