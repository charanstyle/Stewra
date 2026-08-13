import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The operator's catalog and who is on it — the platform-fee half of the pricing model. Message
 * costs pass through at Meta's exact price (migrations 050/051); the flat fee on a plan version is
 * the platform's entire own revenue, and this schema is shaped so that fee can never move under a
 * subscriber silently.
 *
 * Three tables, same versioning philosophy as the rate cards:
 *
 *  - `commerce_plans` is only a name. Every number lives on a version.
 *  - `commerce_plan_versions` are immutable (trigger below). Changing a plan's fee appends version
 *    N+1; whoever subscribed under version N keeps version N's fee until an operator moves them.
 *  - `commerce_subscriptions` point at a VERSION, not a plan — the row is the frozen agreement.
 *    At most one is active per org (partial unique below); assigning a new plan ends the old row
 *    and inserts a fresh one, so "what was this org paying in March?" keeps its answer.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('commerce_plans')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'varchar(120)', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('commerce_plan_versions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // RESTRICT: a plan with versions can never disappear — subscriptions and invoices trace to it.
    .addColumn('plan_id', 'uuid', (col) =>
      col.notNull().references('commerce_plans.id').onDelete('restrict'),
    )
    /** 1-based and dense per plan; the repository computes max+1 inside a transaction. */
    .addColumn('version', 'integer', (col) => col.notNull().check(sql`version >= 1`))
    /** The flat monthly fee, micros. Zero is a legal fee — a free pilot is still an agreement. */
    .addColumn('platform_fee_micros', 'bigint', (col) =>
      col.notNull().check(sql`platform_fee_micros >= 0`),
    )
    /** ISO 4217, uppercase — the currency the fee line lands on the invoice in. */
    .addColumn('currency', 'varchar(3)', (col) => col.notNull().check(sql`currency ~ '^[A-Z]{3}$'`))
    /** Why this version exists. Required for the same reason a rate card's source_note is. */
    .addColumn('note', 'text', (col) => col.notNull())
    .addColumn('created_by_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_commerce_plan_versions_plan_version', ['plan_id', 'version'])
    .execute();

  // A version is what somebody's invoice was computed from — it is never edited and never deleted.
  // A wrong fee is corrected by appending a new version, which leaves the wrong one visible as
  // what its era's invoices actually charged.
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_plan_versions_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'commerce_plan_versions is append-only: % is not permitted; create a new version instead', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_commerce_plan_versions_append_only
    BEFORE UPDATE OR DELETE ON commerce_plan_versions
    FOR EACH ROW EXECUTE FUNCTION stewra_commerce_plan_versions_append_only();
  `.execute(db);

  await db.schema
    .createTable('commerce_subscriptions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    // RESTRICT: the version a subscription froze must outlive it.
    .addColumn('plan_version_id', 'uuid', (col) =>
      col.notNull().references('commerce_plan_versions.id').onDelete('restrict'),
    )
    .addColumn('started_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    /** NULL while active. Stamped when the org is moved to another plan or off plans entirely. */
    .addColumn('ended_at', 'timestamptz')
    /** Why the org is (or stopped being) on this plan — "signed order form", "churned". */
    .addColumn('note', 'text', (col) => col.notNull())
    .addColumn('created_by_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'ck_commerce_subscriptions_window_ordered',
      sql`ended_at is null or ended_at >= started_at`,
    )
    .execute();

  // One active subscription per org. Partial unique rather than an application check so two
  // concurrent assignments cannot both leave an open row — one loses at the database.
  await sql`
    CREATE UNIQUE INDEX uq_commerce_subscriptions_active_per_org
    ON commerce_subscriptions (org_id)
    WHERE ended_at IS NULL;
  `.execute(db);

  // The billing close asks "which subscription overlapped this month?" — keep that scan indexed.
  await db.schema
    .createIndex('idx_commerce_subscriptions_org_started')
    .on('commerce_subscriptions')
    .columns(['org_id', 'started_at'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_subscriptions').execute();
  await sql`DROP TRIGGER IF EXISTS trg_commerce_plan_versions_append_only ON commerce_plan_versions;`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS stewra_commerce_plan_versions_append_only();`.execute(db);
  await db.schema.dropTable('commerce_plan_versions').execute();
  await db.schema.dropTable('commerce_plans').execute();
}
