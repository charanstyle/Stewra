import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // Email-ownership flag on the user. Defaults false: a new account is unverified until the user
  // enters the code we email them. The gated routes (connect a source, generate an insight) check it.
  await db.schema
    .alterTable('users')
    .addColumn('email_verified', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();

  // One row per issued verification code. Short-lived, single-use, attempt-limited, and bound to the
  // user. A 6-digit code is not a secret credential (so it does NOT live in the vault), but it is
  // still self-expiring and rate-limited so it can't be brute-forced or replayed.
  await db.schema
    .createTable('email_verification_codes')
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
    .createIndex('idx_evc_user_id')
    .on('email_verification_codes')
    .column('user_id')
    .execute();
  await db.schema
    .createIndex('idx_evc_expires_at')
    .on('email_verification_codes')
    .column('expires_at')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('email_verification_codes').execute();
  await db.schema.alterTable('users').dropColumn('email_verified').execute();
}
