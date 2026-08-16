import { z } from 'zod';
import type { CommerceJob } from '@stewra/shared-types';
import type { JobHandler, JobOutcome } from './types.js';
import { billingService } from '../services/billingService.js';
import { invoiceRepository } from '../repositories/invoiceRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { logger } from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';

const payloadSchema = z.object({
  /** First of the month, UTC — the period being closed. */
  periodStart: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/),
});

/**
 * Bill one org's month, in advance, on the first day it covers.
 *
 * `done` covers both honest outcomes: billed, and already-billed (a replayed job finding finished
 * work). There is no longer a "waiting on pricing" outcome — a flat fee is fully known when its
 * period begins, so the only reason a period does not produce an invoice is that nobody owed one.
 *
 * Idempotent end to end — the period marker short-circuits a billed month, issued invoices are
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
      logger.info('commerce billing: period billing job finished', {
        orgId: job.orgId,
        periodStart: parsed.data.periodStart,
        outcome: result.outcome,
        invoices: result.invoices.length,
      });
      return { kind: 'done' };
    } catch (error) {
      if (error instanceof ValidationError) {
        // A malformed period, or one that has not begun, never becomes billable by retrying this
        // same payload.
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
 * Queue billing for every (org, month) that needs it: the CURRENT month for every org holding a
 * subscription in it, plus any earlier period a previous sweep left marked open.
 *
 * The month is the current one, not the last ended one, because the fee is charged in advance —
 * an org subscribed on the 1st is invoiced that same day for the month ahead. Nothing waits for
 * the month to finish because nothing about a flat fee changes while it runs.
 *
 * The dedupe key is (org, period, hour), so a period is attempted at most hourly and the attempts
 * stop on their own the moment the marker says closed, because `periodsNeedingClose` stops
 * returning it. Note that it dedupes against every job carrying that key regardless of status, so a
 * FINISHED close still blocks a re-run for the rest of the hour — which is what makes the marker
 * the thing to look at when a period seems stuck, not the queue.
 *
 * Deliberately NOT gated on `metaCommerce.enabled`. The platform fee is owed whether or not the org
 * ever sends a WhatsApp message, and issuing an invoice involves no third party at all. With no
 * subscriptions this returns zero, which is the honest answer rather than a suppressed one.
 */
export async function enqueueBillingPeriodCloses(): Promise<number> {
  const now = new Date();
  // The month in progress — billed on its first day, for itself.
  const periodStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const periodEnd = next.toISOString().slice(0, 10);

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
