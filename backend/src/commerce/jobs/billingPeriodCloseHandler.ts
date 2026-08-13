import { z } from 'zod';
import type { CommerceJob } from '@stewra/shared-types';
import type { JobHandler, JobOutcome } from './types.js';
import { billingService } from '../services/billingService.js';
import { invoiceRepository } from '../repositories/invoiceRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { config } from '../../config/unifiedConfig.js';
import { logger } from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';

const payloadSchema = z.object({
  /** First of the month, UTC — the period being closed. */
  periodStart: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/),
});

/**
 * Close one org's ended month into invoices.
 *
 * `done` covers three honest outcomes: issued, still-open (the period has unrated or unpriced
 * messages — the sweep will bring the job back after the backfill has had its hour), and
 * already-closed (a replayed job finding finished work). None of them is worth a retry loop:
 * the close either succeeded, or is waiting on DATA no retry produces.
 *
 * Idempotent end to end — the period marker short-circuits a closed month, issued invoices are
 * never rewritten, and a draft is rebuilt whole rather than appended to.
 */
class BillingPeriodCloseHandler implements JobHandler {
  readonly kind = 'billing_period_close' as const;

  async handle(job: CommerceJob): Promise<JobOutcome> {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      return {
        kind: 'failed',
        reason: `payload is not a billing_period_close payload: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }

    try {
      const result = await billingService.closePeriod({
        orgId: job.orgId,
        periodStart: parsed.data.periodStart,
      });
      if (result.outcome === 'still_open') {
        logger.info('commerce billing: period not closeable yet — drafts written, waiting on pricing', {
          orgId: job.orgId,
          periodStart: parsed.data.periodStart,
        });
      }
      return { kind: 'done' };
    } catch (error) {
      if (error instanceof ValidationError) {
        // A malformed or not-yet-ended period never becomes closeable by retrying this payload.
        return { kind: 'failed', reason: error.message };
      }
      return {
        kind: 'retry',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const billingPeriodCloseHandler = new BillingPeriodCloseHandler();

/**
 * Queue a close for every (org, month) that needs one: the just-ended month for every org with
 * activity in it, plus any earlier month still marked open — a period whose stragglers the
 * backfill priced late closes on the next sweep instead of never.
 *
 * The dedupe key is (org, period, hour): an open period is re-attempted at most hourly, and the
 * attempts stop on their own the moment the marker says closed, because `periodsNeedingClose`
 * stops returning it.
 */
export async function enqueueBillingPeriodCloses(): Promise<number> {
  if (!config.metaCommerce.enabled) return 0;

  const now = new Date();
  // The most recently ENDED month: first of this month is its exclusive end.
  const periodEnd = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodStart = prev.toISOString().slice(0, 10);

  const due = await invoiceRepository.periodsNeedingClose({ periodStart, periodEnd });
  if (due.length === 0) return 0;

  const hour = now.toISOString().slice(0, 13);
  let enqueued = 0;
  for (const item of due) {
    const job = await jobRepository.enqueue({
      orgId: item.orgId,
      kind: 'billing_period_close',
      payload: { periodStart: item.periodStart },
      dedupeKey: `billing_period_close:${item.orgId}:${item.periodStart}:${hour}`,
    });
    if (job !== null) enqueued += 1;
  }
  logger.info('commerce billing: period closes enqueued', { due: due.length, enqueued });
  return enqueued;
}
