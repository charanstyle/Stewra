import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // The global kill switch (build-plan M5): while true, every brokered read is denied and scheduled
  // background work skips the user. A DB-level default of false so every existing row and every new
  // user starts un-paused — pausing is only ever an explicit act.
  await db.schema
    .alterTable('user_preferences')
    .addColumn('pause_all', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('user_preferences').dropColumn('pause_all').execute();
}
