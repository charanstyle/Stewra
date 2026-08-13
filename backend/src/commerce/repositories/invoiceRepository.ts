import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { CommerceInvoice, CommerceInvoiceLine } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type { CommerceInvoicesTable, CommerceInvoiceLinesTable } from '../../database/types.js';

type InvoiceRow = Selectable<CommerceInvoicesTable>;
type LineRow = Selectable<CommerceInvoiceLinesTable>;

/** pg `date` comes back as a Date at UTC midnight; the API carries YYYY-MM-DD. */
function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toInvoice(row: InvoiceRow): CommerceInvoice {
  return {
    id: row.id,
    orgId: row.org_id,
    currency: row.currency,
    periodStart: toDateString(row.period_start),
    periodEnd: toDateString(row.period_end),
    status: row.status,
    totalMicros: row.total_micros,
    unratedBillable: row.unrated_billable,
    unpricedMessages: row.unpriced_messages,
    issuedAt: row.issued_at === null ? null : row.issued_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toLine(row: LineRow): CommerceInvoiceLine {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    kind: row.kind,
    description: row.description,
    quantity: row.quantity,
    amountMicros: row.amount_micros,
  };
}

/** One line as the close job computes it, before it has a row. */
export interface InvoiceLineInput {
  kind: CommerceInvoiceLine['kind'];
  description: string;
  quantity: number;
  amountMicros: bigint;
}

/**
 * Invoices and the close job's steering rows (migration 054).
 *
 * The write path is deliberately narrow: `writeCloseOutcome` is the ONLY way an invoice or its
 * lines change, and it refuses to touch anything past `draft` — the database trigger enforces the
 * same rule underneath, so a bug here is an exception, not a rewritten bill.
 */
class InvoiceRepository {
  /**
   * Record one close attempt's result for one (org, currency, month): create or rebuild the draft
   * invoice with these lines, and — when the period is complete — issue it. Returns the invoice as
   * written, or the existing one untouched when it has already issued (a re-run against a closed
   * period is a no-op, not an error).
   */
  async writeCloseOutcome(params: {
    orgId: string;
    currency: string;
    /** YYYY-MM-01 */
    periodStart: string;
    /** First day of the next month, YYYY-MM-DD. */
    periodEnd: string;
    lines: InvoiceLineInput[];
    unratedBillable: number;
    unpricedMessages: number;
    issue: boolean;
  }): Promise<CommerceInvoice> {
    const total = params.lines.reduce((sum, line) => sum + line.amountMicros, 0n);
    return db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('commerce_invoices')
        .selectAll()
        .where('org_id', '=', params.orgId)
        .where('currency', '=', params.currency)
        .where('period_start', '=', sql<Date>`${params.periodStart}::date`)
        .executeTakeFirst();

      if (existing !== undefined && existing.status !== 'draft') {
        // Issued, paid or void: the document is evidence now. The close job re-running (a lease
        // expiry, a replayed sweep) must find it and leave it alone.
        return toInvoice(existing);
      }

      let invoiceId: string;
      if (existing === undefined) {
        const inserted = await trx
          .insertInto('commerce_invoices')
          .values({
            org_id: params.orgId,
            currency: params.currency,
            period_start: params.periodStart,
            period_end: params.periodEnd,
            status: 'draft',
            total_micros: total.toString(),
            unrated_billable: params.unratedBillable,
            unpriced_messages: params.unpricedMessages,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        invoiceId = inserted.id;
      } else {
        invoiceId = existing.id;
        await trx
          .updateTable('commerce_invoices')
          .set({
            total_micros: total.toString(),
            unrated_billable: params.unratedBillable,
            unpriced_messages: params.unpricedMessages,
            updated_at: new Date(),
          })
          .where('id', '=', invoiceId)
          .execute();
        // A draft's lines are workpaper — rebuilt whole, never patched, so a category that
        // disappeared from the period (a backfill re-rated it) disappears from the document too.
        await trx.deleteFrom('commerce_invoice_lines').where('invoice_id', '=', invoiceId).execute();
      }

      if (params.lines.length > 0) {
        await trx
          .insertInto('commerce_invoice_lines')
          .values(
            params.lines.map((line) => ({
              invoice_id: invoiceId,
              kind: line.kind,
              description: line.description,
              quantity: line.quantity,
              amount_micros: line.amountMicros.toString(),
            })),
          )
          .execute();
      }

      if (params.issue) {
        // Issue LAST, inside the same transaction: the trigger freezes the lines the moment the
        // status leaves draft, so the order here is the only order that works.
        await trx
          .updateTable('commerce_invoices')
          .set({ status: 'issued', issued_at: new Date(), updated_at: new Date() })
          .where('id', '=', invoiceId)
          .execute();
      }

      const row = await trx
        .selectFrom('commerce_invoices')
        .selectAll()
        .where('id', '=', invoiceId)
        .executeTakeFirstOrThrow();
      return toInvoice(row);
    });
  }

  async listForOrg(orgId: string): Promise<CommerceInvoice[]> {
    const rows = await db
      .selectFrom('commerce_invoices')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('period_start', 'desc')
      .orderBy('currency')
      .execute();
    return rows.map(toInvoice);
  }

  /** Org-scoped by both ids, so a guessed invoice id from another tenant reads as absent. */
  async getWithLines(
    orgId: string,
    invoiceId: string,
  ): Promise<{ invoice: CommerceInvoice; lines: CommerceInvoiceLine[] } | null> {
    const row = await db
      .selectFrom('commerce_invoices')
      .selectAll()
      .where('id', '=', invoiceId)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const lines = await db
      .selectFrom('commerce_invoice_lines')
      .selectAll()
      .where('invoice_id', '=', invoiceId)
      .orderBy('kind')
      .execute();
    return { invoice: toInvoice(row), lines: lines.map(toLine) };
  }

  /**
   * The operator's view of one invoice, unscoped by org — the install-admin gate is the scope.
   * Never reachable from an /orgs route.
   */
  async findById(invoiceId: string): Promise<CommerceInvoice | null> {
    const row = await db
      .selectFrom('commerce_invoices')
      .selectAll()
      .where('id', '=', invoiceId)
      .executeTakeFirst();
    return row === undefined ? null : toInvoice(row);
  }

  /**
   *`issued → paid`, and nothing else: the database trigger permits exactly this transition with
   * every other column byte-identical, so the update is status-only by necessity, not politeness.
   * Returns the invoice as it now stands, or null when it does not exist.
   */
  async markPaid(invoiceId: string): Promise<CommerceInvoice | null> {
    const row = await db
      .updateTable('commerce_invoices')
      .set({ status: 'paid', updated_at: new Date() })
      .where('id', '=', invoiceId)
      .where('status', '=', 'issued')
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) return toInvoice(row);
    return this.findById(invoiceId);
  }

  /** Stamp the (org, month) marker with this close attempt's outcome. */
  async markPeriod(params: {
    orgId: string;
    periodStart: string;
    status: 'open' | 'closed';
    unratedBillable: number;
    unpricedMessages: number;
  }): Promise<void> {
    const closedAt = params.status === 'closed' ? new Date() : null;
    await db
      .insertInto('commerce_billing_periods')
      .values({
        org_id: params.orgId,
        period_start: params.periodStart,
        status: params.status,
        unrated_billable: params.unratedBillable,
        unpriced_messages: params.unpricedMessages,
        closed_at: closedAt,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'period_start']).doUpdateSet({
          status: params.status,
          unrated_billable: params.unratedBillable,
          unpriced_messages: params.unpricedMessages,
          closed_at: closedAt,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  /** Whether this (org, month) has already closed — the re-run guard the close job checks first. */
  async isPeriodClosed(orgId: string, periodStart: string): Promise<boolean> {
    const row = await db
      .selectFrom('commerce_billing_periods')
      .select('status')
      .where('org_id', '=', orgId)
      .where('period_start', '=', sql<Date>`${periodStart}::date`)
      .executeTakeFirst();
    return row?.status === 'closed';
  }

  /**
   * Which (org, month) pairs the hourly sweep should enqueue closes for: every org with activity
   * in the just-ended month that has no marker yet, plus every marker still `open` from any
   * earlier month (a period that completed late — the backfill priced its stragglers — closes on
   * the next sweep instead of never).
   *
   * "Activity" is any of: a cost row priced in the window, a message created in the window, or a
   * subscription overlapping it — the three things that can put a line or a hold on the document.
   */
  async periodsNeedingClose(params: {
    /** YYYY-MM-01 of the most recently ENDED month. */
    periodStart: string;
    /** First day of the following month. */
    periodEnd: string;
  }): Promise<{ orgId: string; periodStart: string }[]> {
    const result = await sql<{ org_id: string; period_start: Date }>`
      SELECT org_id, ${params.periodStart}::date AS period_start
      FROM (
        SELECT org_id FROM commerce_message_costs
          WHERE priced_at >= ${params.periodStart}::date AND priced_at < ${params.periodEnd}::date
        UNION
        SELECT org_id FROM commerce_messages
          WHERE created_at >= ${params.periodStart}::date AND created_at < ${params.periodEnd}::date
        UNION
        SELECT org_id FROM commerce_subscriptions
          WHERE started_at < ${params.periodEnd}::date
            AND (ended_at IS NULL OR ended_at > ${params.periodStart}::date)
      ) active
      WHERE NOT EXISTS (
        SELECT 1 FROM commerce_billing_periods p
        WHERE p.org_id = active.org_id
          AND p.period_start = ${params.periodStart}::date
          AND p.status = 'closed'
      )
      UNION
      SELECT org_id, period_start FROM commerce_billing_periods
      WHERE status = 'open'
    `.execute(db);
    return result.rows.map((row) => ({
      orgId: row.org_id,
      periodStart: toDateString(row.period_start),
    }));
  }
}

export const invoiceRepository = new InvoiceRepository();
