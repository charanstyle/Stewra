import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The money store (personal-plane Milestone 2): accounts, transactions, and a sync cursor per bank
 * connection, filled server-side from the aggregator (Plaid). Raw records live ONLY here in the
 * control plane; the agent sees derived fact strings through the broker, never these rows.
 *
 * Merchant/description text is encrypted at rest with the same AES-256-GCM strength as email bodies
 * (via fieldCrypto) — a transaction description is as private as a message. Amounts are bigint
 * MICROS (Plaid's decimal scaled by 1e6 exactly), positive = money leaving the account, matching
 * Plaid's sign convention. Everything is user-scoped and CASCADE-deletes on user/connection removal;
 * the disconnect path additionally purges rows explicitly because a revoked connection only flips
 * status (the CASCADE never fires), mirroring the email store.
 *
 * Plaid ids and the /transactions/sync cursor are stored as varchar/text — opaque strings, never
 * parsed as numbers (the same precision argument as Gmail history ids).
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // One row per bank account inside a connected Item; balances are overwritten each sync (they are
  // a snapshot, not a ledger — the ledger is the transactions table).
  await sql`
    CREATE TABLE money_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      plaid_account_id varchar(255) NOT NULL,
      name text NOT NULL DEFAULT '',
      account_type varchar(32) NOT NULL DEFAULT '',
      account_subtype varchar(64) NOT NULL DEFAULT '',
      mask varchar(8) NOT NULL DEFAULT '',
      iso_currency_code varchar(3),
      available_micros bigint,
      current_micros bigint,
      balance_as_of timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_money_accounts_conn_plaid
      ON money_accounts (connection_id, plaid_account_id)
  `.execute(db);
  await sql`CREATE INDEX idx_money_accounts_user ON money_accounts (user_id)`.execute(db);

  // Individual transactions. `posted_at` is Plaid's YYYY-MM-DD transaction date; `pending` rows are
  // replaced by their posted successors through the sync's removed/added lists.
  await sql`
    CREATE TABLE money_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      account_id uuid NOT NULL REFERENCES money_accounts(id) ON DELETE CASCADE,
      plaid_transaction_id varchar(255) NOT NULL,
      merchant_ciphertext text NOT NULL DEFAULT '',
      category varchar(128) NOT NULL DEFAULT '',
      amount_micros bigint NOT NULL,
      iso_currency_code varchar(3),
      posted_at date NOT NULL,
      pending boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_money_transactions_conn_plaid
      ON money_transactions (connection_id, plaid_transaction_id)
  `.execute(db);
  await sql`
    CREATE INDEX idx_money_transactions_user_posted ON money_transactions (user_id, posted_at)
  `.execute(db);
  await sql`CREATE INDEX idx_money_transactions_account ON money_transactions (account_id)`.execute(
    db,
  );

  // One sync-state row per connection: the /transactions/sync cursor, persisted after every page so
  // a crash resumes rather than restarting. `initial_sync_complete` distinguishes "first full pull
  // still running" from "up to date as of the cursor".
  await sql`
    CREATE TABLE money_sync_state (
      connection_id uuid PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cursor text,
      initial_sync_complete boolean NOT NULL DEFAULT false,
      last_synced_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('money_sync_state').execute();
  await db.schema.dropTable('money_transactions').execute();
  await db.schema.dropTable('money_accounts').execute();
}
