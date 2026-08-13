import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Per-organization spend caps — the tables that make "an org cannot run up unbounded Meta cost on
 * this install" true at the database rather than in a code path.
 *
 * Three tables, three jobs:
 *
 * - `commerce_spend_caps` — the granted limit, one per (org, currency). **Absence is the default,
 *   and the default is ZERO**: a new organization gets no billable third-party spend until someone
 *   with install-operator authority grants headroom (or, later, a payment does). Free and
 *   service-window traffic never consults this table — the cap governs money, not messaging.
 *
 * - `commerce_spend_periods` — one counter row per (org, currency, calendar month, UTC). Rated
 *   cost only exists AFTER Meta's delivery receipt, so the cap is enforced against RESERVATIONS
 *   made before each send, and check-and-consume is one UPDATE whose WHERE clause holds the limit —
 *   two workers racing the same headroom cannot both pass, because one of them loses at the row
 *   lock, not at a code path both already passed.
 *
 * - `commerce_spend_ledger` — append-only, one row per event (grant, reserve, release, settle),
 *   so every micro in the period counters can be explained. The counters are the enforcement; the
 *   ledger is the evidence.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('commerce_spend_caps')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    /** ISO 4217, matching the WABA's billing currency the reservation will be priced in. */
    .addColumn('currency', 'varchar(3)', (col) => col.notNull().check(sql`currency ~ '^[A-Z]{3}$'`))
    /**
     * The month's allowance in micros. Zero is a real value — an explicit "this org may spend
     * nothing", distinct from no row only in that someone decided it on purpose.
     */
    .addColumn('limit_micros', 'bigint', (col) => col.notNull().check(sql`limit_micros >= 0`))
    .addColumn('granted_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    /**
     * Why this org has this headroom — "paid invoice #12", "pilot agreement". Required: a limit
     * that cannot say why it exists cannot be defended when the org asks for more.
     */
    .addColumn('note', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_commerce_spend_caps_org_currency', ['org_id', 'currency'])
    .execute();

  await db.schema
    .createTable('commerce_spend_periods')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('currency', 'varchar(3)', (col) => col.notNull().check(sql`currency ~ '^[A-Z]{3}$'`))
    /** First day of the calendar month, UTC. The cap is monthly because Meta's billing is. */
    .addColumn('period_start', 'date', (col) => col.notNull())
    /** Micros promised to in-flight sends whose receipts have not landed. */
    .addColumn('reserved_micros', 'bigint', (col) =>
      col.notNull().defaultTo(0).check(sql`reserved_micros >= 0`),
    )
    /**
     * Micros Meta actually charged, per rated receipts. May legitimately exceed the limit — a
     * conversation-priced receipt can cost more than its per-message reservation — the limit binds
     * at reservation time, and the overshoot is visible here rather than hidden.
     */
    .addColumn('actual_micros', 'bigint', (col) =>
      col.notNull().defaultTo(0).check(sql`actual_micros >= 0`),
    )
    .addUniqueConstraint('uq_commerce_spend_periods_org_currency_month', [
      'org_id',
      'currency',
      'period_start',
    ])
    .execute();

  await db.schema
    .createTable('commerce_spend_ledger')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('currency', 'varchar(3)', (col) => col.notNull().check(sql`currency ~ '^[A-Z]{3}$'`))
    .addColumn('period_start', 'date', (col) => col.notNull())
    /**
     * `cap_set` records a grant (amount = the new limit). `reserve` holds estimated money before a
     * send; exactly one of `release` (the send certainly did not happen — Meta refused it) or
     * `settle` (a receipt priced it; amount = the actual charge, possibly 0) closes it.
     * `actual_unreserved` books a charge that never had a reservation, so actuals stay complete.
     */
    .addColumn('kind', 'varchar(20)', (col) =>
      col
        .notNull()
        .check(sql`kind in ('cap_set', 'reserve', 'release', 'settle', 'actual_unreserved')`),
    )
    .addColumn('amount_micros', 'bigint', (col) => col.notNull().check(sql`amount_micros >= 0`))
    .addColumn('message_id', 'uuid', (col) =>
      col.references('commerce_messages.id').onDelete('set null'),
    )
    .addColumn('broadcast_id', 'uuid', (col) =>
      col.references('commerce_broadcasts.id').onDelete('set null'),
    )
    .addColumn('note', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // One reservation per message, and one closing entry per message — enforced as partial unique
  // indexes so a replayed webhook or a retried worker collides at the database instead of
  // double-crediting the period counters. The insert-the-entry-first-then-move-the-counters
  // transaction shape in spendCapRepository leans on exactly this.
  await sql`
    CREATE UNIQUE INDEX uq_commerce_spend_ledger_reserve_per_message
    ON commerce_spend_ledger (message_id)
    WHERE kind = 'reserve' AND message_id IS NOT NULL;
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_commerce_spend_ledger_close_per_message
    ON commerce_spend_ledger (message_id)
    WHERE kind IN ('release', 'settle') AND message_id IS NOT NULL;
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_commerce_spend_ledger_unreserved_per_message
    ON commerce_spend_ledger (message_id)
    WHERE kind = 'actual_unreserved' AND message_id IS NOT NULL;
  `.execute(db);

  await db.schema
    .createIndex('idx_commerce_spend_ledger_org_created')
    .on('commerce_spend_ledger')
    .columns(['org_id', 'created_at'])
    .execute();

  /**
   * The ledger is append-only for the same reason `audit_log` and the rate-card tables are: it is
   * the evidence trail for money, and a rule living only in the repository is one careless
   * `.updateTable()` away from gone.
   */
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_spend_ledger_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'commerce_spend_ledger is append-only: rows are never updated or deleted';
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER stewra_commerce_spend_ledger_append_only
    BEFORE UPDATE OR DELETE ON commerce_spend_ledger
    FOR EACH ROW EXECUTE FUNCTION stewra_commerce_spend_ledger_append_only();
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS stewra_commerce_spend_ledger_append_only ON commerce_spend_ledger;`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS stewra_commerce_spend_ledger_append_only();`.execute(db);
  await db.schema.dropTable('commerce_spend_ledger').execute();
  await db.schema.dropTable('commerce_spend_periods').execute();
  await db.schema.dropTable('commerce_spend_caps').execute();
}
