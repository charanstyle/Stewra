import type { CommerceJob } from '@stewra/shared-types';
import type { JobHandler, JobOutcome } from './types.js';
import { costRatingService } from '../services/costRatingService.js';
import { spendCapService } from '../services/spendCapService.js';
import { messageCostRepository } from '../repositories/messageCostRepository.js';
import { spendCapRepository } from '../repositories/spendCapRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { config } from '../../config/unifiedConfig.js';
import { logger } from '../../utils/logger.js';

/** One query's worth of work; the loop below drains batches until the org is clean. */
const BATCH_SIZE = 200;

/** A ceiling per job run, so one org with a mountain of stragglers cannot hold a worker slot for
 *  minutes — whatever remains is picked up by the next hourly sweep. */
const MAX_PER_RUN = 5_000;

/**
 * How long a send may sit with no delivery receipt before its spend reservation is released.
 * Meta's receipts normally land in seconds and its webhook retries span days, not weeks — after
 * seven days the overwhelmingly likely truth is that the receipt is never coming, and an org's
 * headroom should not stay mortgaged to it forever. If a receipt DOES arrive later, the rater
 * books the real charge as an unreserved actual, so the money is still counted — the only thing
 * given up at day seven is the hold, never the record.
 */
const STALE_RESERVATION_DAYS = 7;

/**
 * The self-healing pass over the money tables: rate every message whose receipt carried pricing
 * but which has no cost row (the rater erred, or the process died between receipt and rating),
 * and release spend reservations stranded by receipts that never came.
 *
 * Everything this calls is idempotent — `rateMessage` writes at most one cost row per message and
 * one closing ledger entry per reservation — so the payload carries nothing but the org and two
 * overlapping runs do no double work.
 */
class MessageCostBackfillHandler implements JobHandler {
  readonly kind = 'message_cost_backfill' as const;

  async handle(job: CommerceJob): Promise<JobOutcome> {
    let rated = 0;
    while (rated < MAX_PER_RUN) {
      const batch = await messageCostRepository.receiptsAwaitingRating({
        orgId: job.orgId,
        limit: BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const item of batch) {
        // Same call the receipt path makes — the backfill is a late receipt, not a second rater.
        await costRatingService.rateMessage({
          orgId: job.orgId,
          messageId: item.messageId,
          conversationId: item.conversationId,
          billable: item.billable,
          pricingCategory: item.pricingCategory,
          providerConversationId: item.providerConversationId,
          billingCurrency: item.billingCurrency,
        });
        rated += 1;
      }
      if (batch.length < BATCH_SIZE) break;
    }

    // Second pass: unrated rows, retried against today's cards. `reRateMessage` replaces a row
    // only when the retry actually prices it, so a still-missing rate leaves the row (and its
    // open period) untouched rather than churning `priced_at` forward every hour.
    let reRated = 0;
    const unrated = await messageCostRepository.unratedOutcomes({
      orgId: job.orgId,
      limit: MAX_PER_RUN,
    });
    for (const item of unrated) {
      const outcome = await costRatingService.reRateMessage({
        orgId: job.orgId,
        messageId: item.messageId,
        conversationId: item.conversationId,
        billable: item.billable,
        pricingCategory: item.pricingCategory,
        providerConversationId: item.providerConversationId,
        billingCurrency: item.billingCurrency,
      });
      if (outcome === 're_rated') reRated += 1;
    }

    const before = new Date(Date.now() - STALE_RESERVATION_DAYS * 24 * 60 * 60 * 1000);
    const stale = await spendCapRepository.staleOpenReservations({
      orgId: job.orgId,
      before,
      limit: MAX_PER_RUN,
    });
    for (const { messageId } of stale) {
      await spendCapService.releaseStaleReservation(messageId);
    }

    if (rated > 0 || reRated > 0 || stale.length > 0) {
      logger.info('commerce billing: cost backfill pass finished', {
        orgId: job.orgId,
        rated,
        reRated,
        staleReservationsReleased: stale.length,
      });
    }
    // A batch that hit MAX_PER_RUN leaves the remainder to the next sweep rather than retrying:
    // the hourly cadence is the pace, and `retry` semantics belong to faults, not to volume.
    return { kind: 'done' };
  }
}

export const messageCostBackfillHandler = new MessageCostBackfillHandler();

/**
 * Queue a backfill for every org that has receipts awaiting rating or reservations gone stale.
 * Hour-bucketed dedupe, same as every sweep: overlapping sweeps enqueue nothing extra, and an org
 * with nothing to heal costs nothing.
 */
export async function enqueueMessageCostBackfills(): Promise<number> {
  if (!config.metaCommerce.enabled) return 0;

  const before = new Date(Date.now() - STALE_RESERVATION_DAYS * 24 * 60 * 60 * 1000);
  const [awaitingRating, unrated, staleHolds] = await Promise.all([
    messageCostRepository.orgsWithReceiptsAwaitingRating(),
    messageCostRepository.orgsWithUnratedOutcomes(),
    spendCapRepository.orgsWithStaleOpenReservations(before),
  ]);
  const orgIds = [...new Set([...awaitingRating, ...unrated, ...staleHolds])];
  if (orgIds.length === 0) return 0;

  const hour = new Date().toISOString().slice(0, 13);
  let enqueued = 0;
  for (const orgId of orgIds) {
    const job = await jobRepository.enqueue({
      orgId,
      kind: 'message_cost_backfill',
      payload: {},
      dedupeKey: `message_cost_backfill:${orgId}:${hour}`,
    });
    if (job !== null) enqueued += 1;
  }
  logger.info('commerce billing: cost backfills enqueued', { orgs: orgIds.length, enqueued });
  return enqueued;
}
