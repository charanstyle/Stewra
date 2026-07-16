import type { Kysely} from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // Connections hold only a VAULT REFERENCE, never a token. The connection service stores the
  // real token in the vault and keeps the handle here. The agent never sees either.
  await db.schema
    .createTable('connections')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('provider', 'varchar(64)', (col) => col.notNull())
    // Which connected account this row is (e.g. one of several Gmail addresses). Empty string for
    // providers without a per-account identity. Lets one user attach multiple Google accounts.
    .addColumn('account_email', 'varchar(320)', (col) => col.notNull().defaultTo(''))
    .addColumn('vault_ref', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('active'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // One row per (user, provider, account) — so several Google accounts can coexist for a user,
  // while reconnecting the same account upserts in place.
  await db.schema
    .createIndex('idx_connections_user_provider_account')
    .on('connections')
    .columns(['user_id', 'provider', 'account_email'])
    .unique()
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('connections').execute();
}
