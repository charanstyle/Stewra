import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // One reaction per (message, user, type). A user may hold at most one of each reaction type on a
  // message; removing a reaction deletes the row. Deleting the message or user cascades these away.
  await db.schema
    .createTable('message_reactions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('message_id', 'uuid', (col) =>
      col.notNull().references('messages.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('reaction_type', 'varchar(16)', (col) =>
      col.notNull().check(sql`reaction_type in ('like', 'love', 'haha', 'wow', 'sad', 'angry')`),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_reaction_message_user_type', ['message_id', 'user_id', 'reaction_type'])
    .execute();

  await db.schema
    .createIndex('idx_reactions_message')
    .on('message_reactions')
    .column('message_id')
    .execute();

  // Per-recipient read receipt. One row per (message, user); presence of the row = that user has read
  // that message. Read state is also summarized by conversation_participants.last_read_at, but this
  // table gives exact per-message "seen by" for receipts.
  await db.schema
    .createTable('message_read_receipts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('message_id', 'uuid', (col) =>
      col.notNull().references('messages.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('read_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_read_receipt_message_user', ['message_id', 'user_id'])
    .execute();

  await db.schema
    .createIndex('idx_read_receipts_message')
    .on('message_read_receipts')
    .column('message_id')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('message_read_receipts').execute();
  await db.schema.dropTable('message_reactions').execute();
}
