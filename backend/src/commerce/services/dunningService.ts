import type { CommerceDelinquency } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import { PaymentRequiredError } from '../../utils/errors.js';

/**
 * What happens to an org that has not paid.
 *
 * The spend cap already bounds how much an org can spend; this bounds how long it can keep spending
 * without settling. They are different levers and both are needed: a generous cap granted months ago
 * to a paying client goes on working perfectly for a client who has since stopped paying.
 *
 * **Derived, never stored.** There is no `past_due` invoice status, and adding one would need a job
 * to flip it — a job whose failure mode is that every delinquent org reads as current and keeps
 * sending on our money. That is the worst direction for this to fail in, so the state is computed
 * from rows that are already immutable: `commerce_invoices` rows that reached `issued` and have not
 * become `paid` or `void`. Nothing to drift, nothing to schedule, and the answer is the same whether
 * or not anything ran last night.
 *
 * **Due on receipt, with a grace window**, rather than payment terms plus a grace window. Two
 * numbers would need two decisions and there is only one policy here; `issued_at` is already
 * stamped and already immutable, so the grace window measures from it. If per-plan terms are ever
 * wanted, that is a column on the invoice and a change to `daysOutstanding`, not to the shape of
 * this file.
 */

/**
 * Days an issued invoice may go unpaid before billable sending stops.
 *
 * Deliberately a constant and not an environment variable. It is a commercial policy that should be
 * the same on every install and legible in review, not a per-deployment knob someone can quietly
 * widen on the box that is having the argument.
 */
export const DUNNING_GRACE_DAYS = 7;

const MS_PER_DAY = 86_400_000;

class DunningService {
  /**
   * The org's standing, in the shape the API and the UI both read.
   *
   * Note `warning` is a real state and not a nicety: the whole point of a grace window is that
   * someone gets told before anything stops, and a client that only finds out by having a campaign
   * refused has been given a worse experience than no grace window at all.
   */
  async delinquency(orgId: string, now: Date = new Date()): Promise<CommerceDelinquency> {
    const outstanding = await db
      .selectFrom('commerce_invoices')
      .select(['id', 'issued_at'])
      .where('org_id', '=', orgId)
      .where('status', '=', 'issued')
      .orderBy('issued_at', 'asc')
      .execute();

    if (outstanding.length === 0) {
      return {
        state: 'current',
        daysOutstanding: 0,
        graceDays: DUNNING_GRACE_DAYS,
        outstandingInvoiceIds: [],
      };
    }

    // `issued_at` is NOT NULL for anything that has issued — the table's own check constraint ties
    // the two together — so an issued row without one is a corrupted record, not a case to smooth
    // over with a default that would read as "issued today" and hand out a fresh grace window.
    const oldest = outstanding[0]?.issued_at;
    if (oldest === undefined || oldest === null) {
      throw new Error(
        `commerce_invoices ${outstanding[0]?.id ?? '(unknown)'} is issued but has no issued_at; ` +
          'delinquency cannot be computed from it',
      );
    }

    const daysOutstanding = Math.floor((now.getTime() - oldest.getTime()) / MS_PER_DAY);
    return {
      state: daysOutstanding > DUNNING_GRACE_DAYS ? 'delinquent' : 'warning',
      daysOutstanding,
      graceDays: DUNNING_GRACE_DAYS,
      outstandingInvoiceIds: outstanding.map((row) => row.id),
    };
  }

  /**
   * The gate at every point that would put billable work in motion, alongside
   * {@link spendCapService.assertHeadroom}. Refuses with 402 rather than 403: this is not "you may
   * not", it is "you may, once this is settled", and a client should be told which.
   */
  async assertNotDelinquent(orgId: string, now: Date = new Date()): Promise<void> {
    const standing = await this.delinquency(orgId, now);
    if (standing.state !== 'delinquent') return;
    throw new PaymentRequiredError(
      `This organization has an invoice unpaid for ${standing.daysOutstanding} days, past the ` +
        `${DUNNING_GRACE_DAYS}-day grace period. Paid messages resume as soon as it is settled.`,
      'PAST_DUE',
    );
  }

  /** Same predicate as {@link assertNotDelinquent}, as a boolean for job handlers that pause rather than throw. */
  async isDelinquent(orgId: string, now: Date = new Date()): Promise<boolean> {
    return (await this.delinquency(orgId, now)).state === 'delinquent';
  }
}

export const dunningService = new DunningService();
