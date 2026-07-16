import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // Reading the user's Sent mail to learn their writing style is a NEW data use, so it is strictly
  // opt-in (memory-and-learning.md — a new data use gates behind explicit consent). This column is the
  // switch. Unlike the other preference columns it carries a DB-level default of `false`, because the
  // opt-in must default OFF for every existing row and every new user until they turn it on.
  await db.schema
    .alterTable('user_preferences')
    .addColumn('learn_from_sent_mail', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('user_preferences').dropColumn('learn_from_sent_mail').execute();
}
