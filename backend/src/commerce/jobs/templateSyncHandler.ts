import { z } from 'zod';
import type { CommerceJob } from '@stewra/shared-types';
import type { JobHandler, JobOutcome } from './types.js';
import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import { templateService } from '../services/templateService.js';
import { describeGraphFailure } from '../services/metaGraph.js';
import { config } from '../../config/unifiedConfig.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { logger } from '../../utils/logger.js';
import { ServiceUnavailableError, ValidationError } from '../../utils/errors.js';

const payloadSchema = z.object({
  channelAccountId: z.string().uuid(),
});

/**
 * Re-read one WABA's templates from Meta.
 *
 * The PULL half of the mirror. Meta pauses templates on its own when recipients report them, deletes
 * them, and re-categorizes them — and it announces all three by webhook, which means a webhook Meta
 * failed to deliver leaves a paused template looking sendable indefinitely. This job is what bounds
 * that window to an hour.
 *
 * Idempotent by construction: the sync is a read followed by an upsert keyed on Meta's own identity
 * for a template. Running it twice writes the same rows twice and changes nothing.
 */
class TemplateSyncHandler implements JobHandler {
  readonly kind = 'template_sync' as const;

  async handle(job: CommerceJob): Promise<JobOutcome> {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      return {
        kind: 'failed',
        reason: `payload is not a template_sync payload: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }

    const account = await channelAccountRepository.findForOrg(
      job.orgId,
      parsed.data.channelAccountId,
    );
    if (account === null) {
      return { kind: 'failed', reason: 'channel account no longer exists' };
    }

    try {
      const result = await templateService.syncAccount(account);
      if (result.changed.length > 0) {
        // Worth a line of its own: "Meta paused one of your templates" is the thing an operator
        // needs to see, and it is invisible inside a count of how many were read.
        logger.info('commerce: template sync changed template states', {
          orgId: job.orgId,
          channelAccountId: account.id,
          synced: result.synced,
          changed: result.changed.map((t) => `${t.name}/${t.language}=${t.status}`),
        });
      }
      return { kind: 'done' };
    } catch (error) {
      if (error instanceof ServiceUnavailableError) {
        // The channel is revoked, or its vaulted credential could not be read — and `resolve` has
        // already marked the account with the reason. Retrying reaches the same dead credential.
        return { kind: 'failed', reason: error.message };
      }
      if (error instanceof ValidationError) {
        // Meta refused the read. Often a permission the client has since removed, which no number of
        // retries restores; the detail carries Meta's own words for what was wrong.
        return { kind: 'failed', reason: describeGraphFailure(error) };
      }
      return { kind: 'retry', reason: describeGraphFailure(error) };
    }
  }
}

export const templateSyncHandler = new TemplateSyncHandler();

/**
 * Queue an hourly sync for every connected WhatsApp account.
 *
 * One job per account rather than one job for all of them, so a single client's revoked credential
 * fails its own job instead of aborting the sweep for everybody behind it in the loop.
 *
 * The dedupe key is the account and the hour. A sweep that overlaps a previous one — because the
 * queue was backed up, or the process restarted mid-hour — enqueues nothing rather than stacking a
 * second read of the same templates behind the first.
 */
export async function enqueueTemplateSyncs(): Promise<number> {
  if (!config.metaCommerce.enabled) return 0;

  const accounts = await channelAccountRepository.listAllActive('whatsapp_cloud');
  if (accounts.length === 0) return 0;

  const hour = new Date().toISOString().slice(0, 13);
  let enqueued = 0;
  for (const account of accounts) {
    const job = await jobRepository.enqueue({
      orgId: account.orgId,
      kind: 'template_sync',
      payload: { channelAccountId: account.id },
      dedupeKey: `template_sync:${account.id}:${hour}`,
    });
    if (job !== null) enqueued += 1;
  }
  logger.info('commerce: template syncs enqueued', { accounts: accounts.length, enqueued });
  return enqueued;
}
