import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // Durable per-user settings. One row per user, created lazily the first time the user changes a
  // setting. When no row exists, the backend falls back to its configured defaults — so columns are
  // NOT NULL (a row always carries a concrete chosen value) with no DB-level default of their own.
  await db.schema
    .createTable('user_preferences')
    .addColumn('user_id', 'uuid', (col) =>
      col.primaryKey().references('users.id').onDelete('cascade'),
    )
    // How far back Gmail is pulled for insights. Bounded application-side to the shared contract
    // limits; the column just stores whatever the user chose within that range.
    .addColumn('gmail_lookback_days', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('user_preferences').execute();
}
