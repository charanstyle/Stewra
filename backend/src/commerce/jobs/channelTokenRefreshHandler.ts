import { z } from 'zod';
import type { CommerceJob } from '@stewra/shared-types';
import type { JobHandler, JobOutcome } from './types.js';
import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import { channelTokenService } from '../services/channelTokenService.js';

/**
 * The payload, validated at the moment of use rather than trusted from the column.
 *
 * A job may have been enqueued by a version of the code that no longer exists — it can sit in the
 * table across a deploy. Parsing here means a payload the current code cannot understand becomes
 * that job's `failed`, naming the field, instead of a `TypeError` thrown from somewhere three calls
 * deeper with no indication of which job caused it.
 */
const payloadSchema = z.object({
  channelAccountId: z.string().uuid(),
});

/**
 * Renew one channel's Meta credential.
 *
 * This is the queue's first consumer, and it is here rather than left on the hourly timer because
 * the timer could not do the one thing this needs: try again. `channelTokenService.refresh` reaches
 * Meta's Graph API, which returns 500s and rate limits like every other HTTP dependency, and the old
 * behaviour on a bad hour was to log the failure and wait a full hour to find out whether it was
 * transient. With sixty days of runway that is survivable; on day fifty-nine it is not.
 *
 * The mapping from `TokenRefreshOutcome` is where the judgement lives:
 *
 *   `extended`     → done. The vault holds a new credential.
 *   `not-extended` → done. The exchange worked and bought no time; the client must reconnect, has
 *                    been told so, and no amount of retrying changes that.
 *   `expired`      → done. Past its deadline and marked `error` in words. There is nothing to renew.
 *   `failed`       → retry. Meta refused or the stored secret could not be read. The first is often
 *                    transient; the second already marked the account broken. Retrying costs one
 *                    Graph call and can recover an account that would otherwise silently die.
 *
 * Idempotent by construction: `refresh` re-reads the row it is given and compares the deadline Meta
 * returns against the one stored, so a job run twice against an already-renewed account sees the new
 * deadline, finds no meaningful extension, and rotates nothing.
 */
class ChannelTokenRefreshHandler implements JobHandler {
  readonly kind = 'channel_token_refresh' as const;

  async handle(job: CommerceJob): Promise<JobOutcome> {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      return {
        kind: 'failed',
        reason: `payload is not a channel_token_refresh payload: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }

    const row = await channelAccountRepository.findForOrg(job.orgId, parsed.data.channelAccountId);
    if (row === null) {
      // Disconnected between enqueue and run. Nothing to renew and nothing wrong — but `failed`
      // rather than `done`, because "the thing this job was about no longer exists" is not the same
      // as "the credential was renewed", and an operator counting successes should not see one.
      return { kind: 'failed', reason: 'channel account no longer exists' };
    }

    const outcome = await channelTokenService.refresh(row);
    if (outcome === 'failed') {
      return { kind: 'retry', reason: 'Meta refused the token exchange, or the secret was unreadable' };
    }
    return { kind: 'done' };
  }
}

export const channelTokenRefreshHandler = new ChannelTokenRefreshHandler();
