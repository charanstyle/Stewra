import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The documents: invoices, their lines, the payment attempts against them (a shell until Phase
 * 2.5's providers), and the period markers the close job steers by.
 *
 * Two refusals carried through from the cost tables shape everything here:
 *
 *  - **No invented totals.** An invoice for a period containing any unrated or unpriced message is
 *    created but held at `draft`, carrying the discrepancy counts on its face. It issues only when
 *    the period is complete — the same honesty as `unrated_no_rate`, promoted to the document.
 *  - **No currency conversion.** One invoice is one currency; an org whose WABA currency changed
 *    mid-period gets one invoice per currency, each true in its own unit. Hence the unique key is
 *    (org, currency, period), not (org, period).
 *
 * An issued invoice is immutable (trigger below): once it claims to be a bill, the only moves left
 * are `paid` and `void`. Corrections are new documents. Late receipts cannot disturb this because
 * rating prices on `priced_at` = now — money that arrives late bills into the OPEN period.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('commerce_invoices')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('currency', 'varchar(3)', (col) => col.notNull().check(sql`currency ~ '^[A-Z]{3}$'`))
    /** First day of the month, UTC. */
    .addColumn('period_start', 'date', (col) => col.notNull())
    /** First day of the NEXT month — the window is half-open, same as every cost query. */
    .addColumn('period_end', 'date', (col) => col.notNull())
    .addColumn('status', 'varchar(8)', (col) =>
      col.notNull().defaultTo('draft').check(sql`status in ('draft', 'issued', 'paid', 'void')`),
    )
    /** Sum of the lines. Recomputed on every draft rebuild; frozen the moment the invoice issues. */
    .addColumn('total_micros', 'bigint', (col) => col.notNull().check(sql`total_micros >= 0`))
    /**
     * The discrepancies that are holding (or last held) the draft: billable messages the rater
     * refused to price, and messages whose receipt has not priced them at all. Snapshotted at each
     * close attempt so the operator sees WHY a period will not issue without querying anything.
     */
    .addColumn('unrated_billable', 'integer', (col) =>
      col.notNull().defaultTo(0).check(sql`unrated_billable >= 0`),
    )
    .addColumn('unpriced_messages', 'integer', (col) =>
      col.notNull().defaultTo(0).check(sql`unpriced_messages >= 0`),
    )
    .addColumn('issued_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'ck_commerce_invoices_window_ordered',
      sql`period_end > period_start`,
    )
    // An invoice that claims to be issued says when; a draft has not issued yet.
    .addCheckConstraint(
      'ck_commerce_invoices_issued_has_timestamp',
      sql`(status = 'draft') = (issued_at is null)`,
    )
    .execute();

  // The close job's idempotency: one document per (org, currency, month). A re-run finds this row
  // and rebuilds or skips it — it can never lay a second invoice beside the first.
  await sql`
    CREATE UNIQUE INDEX uq_commerce_invoices_org_currency_period
    ON commerce_invoices (org_id, currency, period_start);
  `.execute(db);

  /**
   * Draft rows are workpaper and may be rebuilt freely. From `issued` onward the document is
   * evidence: the only legal UPDATE is the status stepping to `paid` or `void` (stamping
   * `updated_at` with it), and DELETE is refused outright so a bill cannot quietly vanish.
   * `paid` and `void` are terminal. Enforced in the database for the same reason the rate cards
   * are: a rule living only in the repository is one careless `.updateTable()` away from gone.
   */
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_invoices_issued_immutable()
    RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'draft' THEN
        RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commerce_invoices: an issued invoice cannot be deleted; void it instead';
      END IF;
      IF OLD.status = 'issued'
         AND NEW.status IN ('paid', 'void')
         AND NEW.id = OLD.id
         AND NEW.org_id = OLD.org_id
         AND NEW.currency = OLD.currency
         AND NEW.period_start = OLD.period_start
         AND NEW.period_end = OLD.period_end
         AND NEW.total_micros = OLD.total_micros
         AND NEW.unrated_billable = OLD.unrated_billable
         AND NEW.unpriced_messages = OLD.unpriced_messages
         AND NEW.issued_at IS NOT DISTINCT FROM OLD.issued_at
         AND NEW.created_at = OLD.created_at THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'commerce_invoices: % is immutable after issue; only issued -> paid/void may change', OLD.id;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_commerce_invoices_issued_immutable
    BEFORE UPDATE OR DELETE ON commerce_invoices
    FOR EACH ROW EXECUTE FUNCTION stewra_commerce_invoices_issued_immutable();
  `.execute(db);

  await db.schema
    .createTable('commerce_invoice_lines')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('invoice_id', 'uuid', (col) =>
      col.notNull().references('commerce_invoices.id').onDelete('cascade'),
    )
    /** The whole pricing model is these two kinds — pass-through and the flat fee. */
    .addColumn('kind', 'varchar(16)', (col) =>
      col.notNull().check(sql`kind in ('message_costs', 'platform_fee')`),
    )
    .addColumn('description', 'text', (col) => col.notNull())
    /** Messages for `message_costs`; 1 for `platform_fee`. */
    .addColumn('quantity', 'integer', (col) => col.notNull().check(sql`quantity >= 0`))
    .addColumn('amount_micros', 'bigint', (col) =>
      col.notNull().check(sql`amount_micros >= 0`),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // One line per kind per invoice: the close rebuilds by delete+insert, and a duplicated kind
    // would mean the same money counted twice on one document.
    .addUniqueConstraint('uq_commerce_invoice_lines_invoice_kind', ['invoice_id', 'kind'])
    .execute();

  /**
   * Lines are mutable exactly as long as their invoice is a draft. The parent-absent branch exists
   * for ON DELETE CASCADE: when the invoice row is already gone, its lines must be allowed to
   * follow it (the invoice trigger above has already ruled on whether that delete was legal).
   */
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_invoice_lines_draft_only()
    RETURNS trigger AS $$
    DECLARE
      parent_status text;
      parent_id uuid;
    BEGIN
      parent_id := CASE TG_OP WHEN 'INSERT' THEN NEW.invoice_id ELSE OLD.invoice_id END;
      SELECT status INTO parent_status FROM commerce_invoices WHERE id = parent_id;
      IF parent_status IS NULL OR parent_status = 'draft' THEN
        RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
      END IF;
      RAISE EXCEPTION 'commerce_invoice_lines: invoice % is %; lines are frozen once the invoice issues', parent_id, parent_status;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_commerce_invoice_lines_draft_only
    BEFORE INSERT OR UPDATE OR DELETE ON commerce_invoice_lines
    FOR EACH ROW EXECUTE FUNCTION stewra_commerce_invoice_lines_draft_only();
  `.execute(db);

  /**
   * Payment attempts — the table Phase 2.5's provider seam writes. Created now so the invoice
   * schema is complete as a set; nothing in this phase inserts here. `idempotency_key` is unique
   * because a provider that cannot honor idempotency is not acceptable (the port will say so in
   * its types), and the database should agree.
   */
  await db.schema
    .createTable('commerce_payment_attempts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('invoice_id', 'uuid', (col) =>
      col.notNull().references('commerce_invoices.id').onDelete('cascade'),
    )
    .addColumn('provider', 'varchar(32)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) =>
      col.notNull().check(sql`status in ('pending', 'succeeded', 'failed')`),
    )
    .addColumn('idempotency_key', 'varchar(255)', (col) => col.notNull().unique())
    /** The provider's own reference (charge id, transfer id) once it has one. */
    .addColumn('provider_ref', 'varchar(255)')
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_commerce_payment_attempts_invoice')
    .on('commerce_payment_attempts')
    .column('invoice_id')
    .execute();

  /**
   * The close job's steering table: one row per (org, month) the close has ever examined.
   * `open` means "tried, could not issue — something is still unrated or unpriced"; the hourly
   * sweep keeps re-enqueueing exactly the periods marked open (plus the newly ended month), and
   * stops the moment a period closes. Without this marker the sweep could not tell "closed with
   * nothing to invoice" from "never closed", and would either re-close forever or miss a period
   * that completed late.
   */
  await db.schema
    .createTable('commerce_billing_periods')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('period_start', 'date', (col) => col.notNull())
    .addColumn('status', 'varchar(8)', (col) =>
      col.notNull().check(sql`status in ('open', 'closed')`),
    )
    /** The discrepancy counts as of the last close attempt — why an open period is open. */
    .addColumn('unrated_billable', 'integer', (col) =>
      col.notNull().defaultTo(0).check(sql`unrated_billable >= 0`),
    )
    .addColumn('unpriced_messages', 'integer', (col) =>
      col.notNull().defaultTo(0).check(sql`unpriced_messages >= 0`),
    )
    .addColumn('closed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'ck_commerce_billing_periods_closed_has_timestamp',
      sql`(status = 'closed') = (closed_at is not null)`,
    )
    .addUniqueConstraint('uq_commerce_billing_periods_org_period', ['org_id', 'period_start'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_billing_periods').execute();
  await db.schema.dropTable('commerce_payment_attempts').execute();
  await sql`DROP TRIGGER IF EXISTS trg_commerce_invoice_lines_draft_only ON commerce_invoice_lines;`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS stewra_commerce_invoice_lines_draft_only();`.execute(db);
  await db.schema.dropTable('commerce_invoice_lines').execute();
  await sql`DROP TRIGGER IF EXISTS trg_commerce_invoices_issued_immutable ON commerce_invoices;`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS stewra_commerce_invoices_issued_immutable();`.execute(db);
  await db.schema.dropTable('commerce_invoices').execute();
}
