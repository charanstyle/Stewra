import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // One row per issued password-reset code. Structurally identical to email_verification_codes but a
  // SEPARATE table: a reset code authorizes a password change for a logged-out user, a distinct and
  // more sensitive capability than confirming an email — so the two never share a code or a lifetime.
  // Short-lived, single-use, attempt-limited, and bound to the user; not a vault-grade credential but
  // self-expiring and rate-limited so it can't be brute-forced or replayed.
  await db.schema
    .createTable('password_reset_codes')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('code', 'varchar(16)', (col) => col.notNull())
    // The address the code was sent to (snapshot at issue time).
    .addColumn('email', 'varchar(255)', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('used', 'boolean', (col) => col.notNull().defaultTo(false))
    // Failed entries against THIS code; at the configured cap the code is burned (lockout).
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_prc_user_id')
    .on('password_reset_codes')
    .column('user_id')
    .execute();
  await db.schema
    .createIndex('idx_prc_expires_at')
    .on('password_reset_codes')
    .column('expires_at')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('password_reset_codes').execute();
}
