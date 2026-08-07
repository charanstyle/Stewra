import { z } from 'zod';
import type { BroadcastRecipient, CommerceJob } from '@stewra/shared-types';
import type { JobHandler, JobOutcome } from './types.js';
import { broadcastRepository } from '../repositories/broadcastRepository.js';
import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import { commerceInboxRepository } from '../repositories/commerceInboxRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { channelAccountService } from '../services/channelAccountService.js';
import { consentService } from '../services/consentService.js';
import { buildSender } from '../services/senders/index.js';
import { WhatsappSendRefusedError } from '../services/senders/whatsappCloudSender.js';
import { templateService } from '../services/templateService.js';
import { logger } from '../../utils/logger.js';
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../../utils/errors.js';

const payloadSchema = z.object({
  broadcastId: z.string().uuid(),
});

/**
 * Recipients per job run. Small on purpose: each batch is one lease, and a lease should be short
 * enough that a stuck batch strands 25 people in `sending`, not a whole campaign.
 */
const BATCH_SIZE = 25;

/**
 * How long a quiet-hours pause waits before checking again. A cadence rather than a computed
 * end-of-quiet-hours instant, so this file holds no second copy of the timezone arithmetic that
 * `consentService` already owns — a few no-op wakeups an hour is the price, drift between two
 * implementations of "when is it okay again" would be the alternative.
 */
const QUIET_HOURS_RETRY_MS = 15 * 60 * 1000;

/**
 * Send one batch of a broadcast, then requeue itself until the ledger runs dry.
 *
 * The chain shape — one batch per job, each enqueueing the next — is what makes a campaign
 * interruptible: cancel, quiet hours, and process death all take effect at a batch boundary, and a
 * batch is 25 people, not 25,000.
 *
 * **Idempotency is asymmetric by design.** A recipient is flipped to `sending` in the same statement
 * that claims them, and `sending` is never reclaimed: a worker that dies between Meta accepting a
 * send and the row settling leaves an unknown outcome, and re-sending a marketing message to a
 * member of the public is a worse failure than under-reporting one send. The consent gate runs per
 * recipient, immediately before their send — a preview hours old grants nothing.
 */
class BroadcastSendHandler implements JobHandler {
  readonly kind = 'broadcast_send' as const;

  async handle(job: CommerceJob): Promise<JobOutcome> {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      return { kind: 'failed', reason: 'payload is not a broadcast_send payload' };
    }
    const { broadcastId } = parsed.data;

    let broadcast = await broadcastRepository.findById(job.orgId, broadcastId);
    if (broadcast === null) {
      return { kind: 'failed', reason: 'broadcast no longer exists' };
    }

    // Terminal states end the chain. `done`, not `failed` — the chain finding nothing left to do is
    // the cancel/completion mechanism working, not a fault in this job.
    if (
      broadcast.status === 'cancelled' ||
      broadcast.status === 'completed' ||
      broadcast.status === 'failed'
    ) {
      return { kind: 'done' };
    }

    // A paused broadcast reached by a send job resumes. The only automatic pause is quiet hours, and
    // this job arriving is the retry cadence firing; if it is still quiet, the per-recipient consent
    // gate below pauses it right back. A member's cancel is a different status and ends above.
    if (broadcast.status === 'paused') {
      const resumed = await broadcastRepository.transition({
        orgId: job.orgId,
        broadcastId,
        from: ['paused'],
        to: 'running',
        lastError: null,
      });
      if (resumed === null) return { kind: 'done' };
      broadcast = resumed;
    }

    // The channel and template are re-verified every batch, not once per campaign — Meta can pause a
    // template or a client can disconnect mid-run, and the batch boundary is where that must stop us.
    const account = await channelAccountRepository.findForOrg(
      job.orgId,
      broadcast.channelAccountId,
    );
    if (account === null) {
      const reason = 'The WhatsApp account this broadcast sends from has been disconnected.';
      await this.markFailed(job.orgId, broadcastId, reason);
      return { kind: 'failed', reason };
    }

    let template;
    try {
      template = await templateService.assertSendable(
        job.orgId,
        broadcast.templateId,
        broadcast.variables.length,
      );
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        const reason = `The template can no longer be sent: ${error.message}`;
        await this.markFailed(job.orgId, broadcastId, reason);
        return { kind: 'failed', reason };
      }
      throw error;
    }

    const claimed = await broadcastRepository.claimPending(broadcastId, BATCH_SIZE);
    if (claimed.length === 0) {
      // Ledger dry: everyone is sent, failed, skipped — or stranded in `sending` by a dead worker,
      // which stays visible in the ledger rather than blocking completion forever.
      await broadcastRepository.transition({
        orgId: job.orgId,
        broadcastId,
        from: ['running'],
        to: 'completed',
        completedAt: new Date(),
      });
      await broadcastRepository.refreshCounts(broadcastId);
      logger.info('commerce: broadcast completed', { orgId: job.orgId, broadcastId });
      return { kind: 'done' };
    }

    let resolved;
    try {
      resolved = await channelAccountService.resolve(account);
    } catch (error) {
      await broadcastRepository.releaseClaims(claimed.map((r) => r.id));
      if (error instanceof ServiceUnavailableError) {
        // Revoked channel or unreadable credential — `resolve` already marked the account. No batch
        // will fare better until the client reconnects.
        await this.markFailed(job.orgId, broadcastId, error.message);
        return { kind: 'failed', reason: error.message };
      }
      throw error;
    }
    const sender = buildSender(resolved);
    const renderedBody = renderTemplateBody(template.bodyText, broadcast.variables);

    for (let i = 0; i < claimed.length; i += 1) {
      const recipient = claimed[i];
      if (recipient === undefined) continue;

      try {
        await consentService.assertMaySend({
          orgId: job.orgId,
          contactId: recipient.contactId,
          platform: account.platform,
          externalId: recipient.externalId,
          purpose: 'marketing',
        });
      } catch (error) {
        if (error instanceof ForbiddenError && error.code === 'QUIET_HOURS') {
          // Quiet hours block the whole organization, not this one person. Everyone not yet
          // attempted goes back to `pending` — nothing has been sent to them, so the release is
          // safe — and the chain parks until the retry cadence brings it back.
          await broadcastRepository.releaseClaims(claimed.slice(i).map((r) => r.id));
          await broadcastRepository.transition({
            orgId: job.orgId,
            broadcastId,
            from: ['running'],
            to: 'paused',
            lastError: error.message,
          });
          await broadcastRepository.refreshCounts(broadcastId);
          await jobRepository.enqueue({
            orgId: job.orgId,
            kind: 'broadcast_send',
            payload: { broadcastId },
            runAfter: new Date(Date.now() + QUIET_HOURS_RETRY_MS),
          });
          return { kind: 'done' };
        }
        if (error instanceof ForbiddenError) {
          // This person may not be messaged — suppressed or opted out since dispatch selected them.
          // The skip with its reason is the evidence the gate ran; then the batch moves on.
          await broadcastRepository.settleRecipient({
            recipientId: recipient.id,
            status: 'skipped',
            reason: error.message,
            providerMessageId: null,
            messageId: null,
            sentAt: null,
          });
          continue;
        }
        throw error;
      }

      const outcome = await this.sendToRecipient({
        orgId: job.orgId,
        broadcast: { id: broadcastId, createdByUserId: broadcast.createdByUserId },
        account: { id: account.id, platform: account.platform },
        template: { id: template.id, name: template.name, language: template.language },
        variables: broadcast.variables,
        renderedBody,
        recipient,
        sender,
      });
      if (outcome !== null) {
        // Unknown-outcome transport failure. Nothing says Meta is reachable for the rest of the
        // batch either, so stop here and let the queue's backoff decide when to try the NEXT batch —
        // this recipient stays `sending`, per the asymmetry above.
        await broadcastRepository.refreshCounts(broadcastId);
        return { kind: 'retry', reason: outcome };
      }
    }

    await broadcastRepository.refreshCounts(broadcastId);
    await jobRepository.enqueue({
      orgId: job.orgId,
      kind: 'broadcast_send',
      payload: { broadcastId },
    });
    return { kind: 'done' };
  }

  /**
   * One recipient: record the message, send it, settle both.
   *
   * Returns null on a settled outcome (sent, or Meta refused), and the error text when the outcome
   * is UNKNOWN — the request errored without Meta answering, so the message may or may not exist.
   * The recipient is left in `sending` with the reason noted, and the message row stays `queued`:
   * both say honestly that nobody knows, instead of a `failed` that might have been delivered.
   */
  private async sendToRecipient(params: {
    orgId: string;
    broadcast: { id: string; createdByUserId: string | null };
    account: { id: string; platform: 'whatsapp_cloud' | 'instagram' | 'messenger' };
    template: { id: string; name: string; language: string };
    variables: readonly string[];
    renderedBody: string;
    recipient: BroadcastRecipient;
    sender: ReturnType<typeof buildSender>;
  }): Promise<string | null> {
    const conversationId = await commerceInboxRepository.upsertConversation({
      orgId: params.orgId,
      channelAccountId: params.account.id,
      contactId: params.recipient.contactId,
      platform: params.account.platform,
    });

    // The message row is written BEFORE the send. A worker that dies in between leaves a `queued`
    // message next to a `sending` recipient — evidence of an attempt — where the reverse order would
    // leave a delivered message with no row and no cost attribution when the receipt arrives.
    const message = await commerceInboxRepository.recordOutbound({
      orgId: params.orgId,
      conversationId,
      platform: params.account.platform,
      body: params.renderedBody,
      sentByUserId: params.broadcast.createdByUserId,
      templateId: params.template.id,
    });

    try {
      const providerMessageId = await params.sender.sendTemplate({
        to: params.recipient.externalId,
        templateName: params.template.name,
        languageCode: params.template.language,
        variables: params.variables,
      });
      await commerceInboxRepository.settleOutbound({
        orgId: params.orgId,
        messageId: message.id,
        status: 'sent',
        providerMessageId,
      });
      await broadcastRepository.settleRecipient({
        recipientId: params.recipient.id,
        status: 'sent',
        reason: null,
        providerMessageId,
        messageId: message.id,
        sentAt: new Date(),
      });
      return null;
    } catch (error) {
      if (error instanceof WhatsappSendRefusedError) {
        // Meta answered no, so no message reached this person — a certain, per-recipient failure
        // (bad number, policy refusal). Recorded and stepped past; the rest of the batch is fine.
        await commerceInboxRepository.settleOutbound({
          orgId: params.orgId,
          messageId: message.id,
          status: 'failed',
          failureReason: error.message,
        });
        await broadcastRepository.settleRecipient({
          recipientId: params.recipient.id,
          status: 'failed',
          reason: error.message,
          providerMessageId: null,
          messageId: message.id,
          sentAt: null,
        });
        return null;
      }

      const reason = error instanceof Error ? error.message : String(error);
      await broadcastRepository.noteSendingError(params.recipient.id, reason);
      logger.error('commerce: broadcast send outcome unknown', {
        orgId: params.orgId,
        broadcastId: params.broadcast.id,
        recipientId: params.recipient.id,
        error: reason,
      });
      return reason;
    }
  }

  private async markFailed(orgId: string, broadcastId: string, reason: string): Promise<void> {
    await broadcastRepository.transition({
      orgId,
      broadcastId,
      from: ['running', 'paused'],
      to: 'failed',
      completedAt: new Date(),
      lastError: reason,
    });
  }
}

/**
 * The template body with its `{{n}}` placeholders filled, for the message row the inbox shows.
 *
 * What the customer's phone displays is rendered by Meta from the approved template; this is our
 * copy of the same substitution so the conversation thread reads as what was said, not as a
 * template's raw source. A placeholder beyond the supplied variables is left visible — the variable
 * count was validated upstream, and rendering an invented value would hide the mismatch if that
 * validation ever regressed.
 */
function renderTemplateBody(bodyText: string, variables: readonly string[]): string {
  return bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (placeholder, index: string) => {
    const value = variables[Number(index) - 1];
    return value === undefined ? placeholder : value;
  });
}

export const broadcastSendHandler = new BroadcastSendHandler();
