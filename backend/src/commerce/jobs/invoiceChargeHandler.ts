import { z } from 'zod';
import type { CommerceJob } from '@stewra/shared-types';
import type { JobHandler, JobOutcome } from './types.js';
import { paymentService } from '../services/paymentService.js';
import { invoiceRepository } from '../repositories/invoiceRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { config } from '../../config/unifiedConfig.js';
import { logger } from '../../utils/logger.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

const payloadSchema = z.object({
  invoiceId: z.string().uuid(),
});

/**
 * Collect one issued invoice through the configured payment provider.
 *
 * This closes the gap that made the whole billing plane observational: invoices issued, and then
 * nothing ever reached for the card. Dunning would eventually notice nobody had paid and stop the
 * org sending — which is the correct response to a client who will not pay, and an absurd one for
 * a client who was never asked.
 *
 * **A declined card is `done`, not `retry`.** The queue's retry ladder exists for faults that
 * clear on their own — a timeout, a 500 from the provider. A decline is a fact about the card, and
 * hammering it minutes later neither changes that fact nor is free: card networks charge for
 * retries and penalise the ones that look like guessing. The next attempt comes from the sweep
 * below, which enqueues at most one per invoice per day, so a failing card gets seven tries inside
 * the seven-day dunning window and then the org stops sending. `retry` is reserved for the case
 * where we genuinely do not know what happened.
 */
class InvoiceChargeHandler implements JobHandler {
  readonly kind = 'invoice_charge' as const;

  async handle(job: CommerceJob): Promise<JobOutcome> {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      return {
        kind: 'failed',
        reason: `payload is not an invoice_charge payload: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }

    try {
      const { attempt, invoice } = await paymentService.chargeInvoice(parsed.data.invoiceId);
      logger.info('commerce billing: invoice collection attempted', {
        orgId: job.orgId,
        invoiceId: parsed.data.invoiceId,
        attemptStatus: attempt.status,
        invoiceStatus: invoice.status,
        error: attempt.error,
      });
      return { kind: 'done' };
    } catch (error) {
      // Both of these say the charge should not be made, and no retry changes that: the invoice is
      // no longer issued (already paid, voided, or never existed), another collector holds the
      // in-flight attempt, or this install collects manually.
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        return { kind: 'failed', reason: error.message };
      }
      return { kind: 'retry', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

export const invoiceChargeHandler = new InvoiceChargeHandler();

/**
 * Queue a collection for every issued invoice whose org has a stored payment method here.
 *
 * The dedupe key is (invoice, day), which is the retry cadence: one attempt per invoice per day,
 * for as long as it stays issued. It stops on its own when the invoice becomes paid — the query
 * stops returning it — or when dunning cuts the org off at seven days and someone has to talk to
 * the client, which is the correct escalation for a card that has failed a week running.
 *
 * A `manual` install enqueues nothing. That is not a fallback: it is the configured provider
 * saying money moves offline here, and inventing card charges against that would be the surprise.
 */
export async function enqueueInvoiceCharges(): Promise<number> {
  if (!config.metaCommerce.enabled) return 0;
  const provider = config.commerceBilling.provider;
  if (provider === 'manual') return 0;

  const due = await invoiceRepository.issuedAwaitingCollection(provider);
  if (due.length === 0) return 0;

  const day = new Date().toISOString().slice(0, 10);
  let enqueued = 0;
  for (const item of due) {
    const job = await jobRepository.enqueue({
      orgId: item.orgId,
      kind: 'invoice_charge',
      payload: { invoiceId: item.invoiceId },
      dedupeKey: `invoice_charge:${item.invoiceId}:${day}`,
    });
    if (job !== null) enqueued += 1;
  }
  logger.info('commerce billing: invoice collections enqueued', { due: due.length, enqueued });
  return enqueued;
}
