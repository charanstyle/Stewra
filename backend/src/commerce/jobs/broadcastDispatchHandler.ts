import { z } from 'zod';
import type { CommerceJob } from '@stewra/shared-types';
import type { JobHandler, JobOutcome } from './types.js';
import { broadcastRepository } from '../repositories/broadcastRepository.js';
import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { segmentRepository } from '../repositories/segmentRepository.js';
import { audienceService } from '../services/audienceService.js';
import { templateService } from '../services/templateService.js';
import { logger } from '../../utils/logger.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

const payloadSchema = z.object({
  broadcastId: z.string().uuid(),
});

/** Audience pages this size are materialized per query. */
const PAGE_SIZE = 500;

/**
 * Turn a scheduled broadcast into its recipient ledger, then hand it to the send chain.
 *
 * This is the moment the audience is decided — the segment rule is evaluated NOW, against consent as
 * it stands now, which is the entire reason a broadcast stores a `segment_id` instead of a list.
 * Every selected contact gets a ledger row: the sendable as `pending`, the blocked as `skipped` with
 * their reason, so "1,240 selected, 890 sent" reads as an explanation instead of a discrepancy.
 *
 * Idempotent by the ledger's unique index: a re-run (worker died mid-materialization) re-reads the
 * segment and inserts only who the first pass missed. Nobody can be inserted twice, and a recipient
 * the send chain already progressed cannot be reset by a late page.
 */
class BroadcastDispatchHandler implements JobHandler {
  readonly kind = 'broadcast_dispatch' as const;

  async handle(job: CommerceJob): Promise<JobOutcome> {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      return { kind: 'failed', reason: 'payload is not a broadcast_dispatch payload' };
    }
    const { broadcastId } = parsed.data;

    const broadcast = await broadcastRepository.findById(job.orgId, broadcastId);
    if (broadcast === null) {
      return { kind: 'failed', reason: 'broadcast no longer exists' };
    }

    // Cancelled between scheduling and now — the normal way a cancel beats a dispatch. The job's
    // work is legitimately finished: there is nothing to do, and that is a success, not a fault.
    if (broadcast.status !== 'scheduled' && broadcast.status !== 'running') {
      return { kind: 'done' };
    }

    // Everything the send depends on is re-checked at dispatch, not trusted from schedule time.
    // Four days is plenty of time for Meta to pause a template or a client to disconnect a channel.
    const account = await channelAccountRepository.findForOrg(
      job.orgId,
      broadcast.channelAccountId,
    );
    if (account === null || account.status !== 'active') {
      const reason =
        account === null
          ? 'The WhatsApp account this broadcast sends from has been disconnected.'
          : `The WhatsApp account this broadcast sends from is ${account.status}` +
            `${account.errorDetail === null ? '' : `: ${account.errorDetail}`}.`;
      await this.markFailed(job.orgId, broadcastId, reason);
      return { kind: 'failed', reason };
    }

    try {
      await templateService.assertSendable(
        job.orgId,
        broadcast.templateId,
        broadcast.variables.length,
      );
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        const detail = error instanceof ValidationError ? describeValidation(error) : error.message;
        const reason = `The template can no longer be sent: ${detail}`;
        await this.markFailed(job.orgId, broadcastId, reason);
        return { kind: 'failed', reason };
      }
      throw error;
    }

    const segment = await audienceService.getSegment(job.orgId, broadcast.segmentId);

    if (broadcast.status === 'scheduled') {
      const started = await broadcastRepository.transition({
        orgId: job.orgId,
        broadcastId,
        from: ['scheduled'],
        to: 'running',
        startedAt: new Date(),
      });
      // Losing this race means someone cancelled in the last few milliseconds. Their word wins.
      if (started === null) return { kind: 'done' };
    }

    // Materialize the ledger, page by page. `sendableOnly: false` on purpose — the blocked members
    // ARE the ledger's point. OFFSET paging is stable here because the ordering is (created_at, id)
    // and a contact created mid-walk lands at the end; the unique index absorbs any overlap.
    let offset = 0;
    let materialized = 0;
    for (;;) {
      const page = await segmentRepository.listAudience({
        orgId: job.orgId,
        definition: segment.definition,
        limit: PAGE_SIZE,
        offset,
        sendableOnly: false,
      });
      if (page.length === 0) break;

      await broadcastRepository.insertRecipients(
        page.map((member) => ({
          orgId: job.orgId,
          broadcastId,
          contactId: member.contactId,
          externalId: member.externalId,
          displayName: member.displayName,
          status: member.blockedReason === null ? 'pending' : 'skipped',
          reason: member.blockedReason,
        })),
      );
      materialized += page.length;
      offset += page.length;
      if (page.length < PAGE_SIZE) break;
    }

    await broadcastRepository.refreshCounts(broadcastId);
    logger.info('commerce: broadcast dispatched', {
      orgId: job.orgId,
      broadcastId,
      materialized,
    });

    await jobRepository.enqueue({
      orgId: job.orgId,
      kind: 'broadcast_send',
      payload: { broadcastId },
    });
    return { kind: 'done' };
  }

  /** The broadcast could not run at all. Recorded on the broadcast, where its owner will look. */
  private async markFailed(orgId: string, broadcastId: string, reason: string): Promise<void> {
    await broadcastRepository.transition({
      orgId,
      broadcastId,
      from: ['scheduled', 'running'],
      to: 'failed',
      completedAt: new Date(),
      lastError: reason,
    });
  }
}

/** Flatten a ValidationError's field details into the sentence the broadcast records. */
function describeValidation(error: ValidationError): string {
  if (error.details.length === 0) return error.message;
  return error.details.map((d) => d.message).join(' ');
}

export const broadcastDispatchHandler = new BroadcastDispatchHandler();
