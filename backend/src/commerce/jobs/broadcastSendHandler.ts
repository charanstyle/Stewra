import { z } from 'zod';
import type { BroadcastRecipient, CommerceJob } from '@stewra/shared-types';
import type { JobHandler, JobOutcome } from './types.js';
import { broadcastRepository } from '../repositories/broadcastRepository.js';
import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import { commerceInboxRepository } from '../repositories/commerceInboxRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { channelAccountService } from '../services/channelAccountService.js';
import { consentService } from '../services/consentService.js';
import { spendCapService } from '../services/spendCapService.js';
import { dunningService } from '../services/dunningService.js';
import { buildSender } from '../services/senders/index.js';
import { WhatsappSendRefusedError } from '../services/senders/whatsappCloudSender.js';
import { renderTemplateBody } from '../services/templateBody.js';
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

    // A paused broadcast reached by a send job resumes — quiet hours' retry cadence firing; if it
    // is still quiet, the per-recipient consent gate below pauses it right back. A member's cancel
    // is a different status and ends above. The one pause a job must NOT undo is the spend cap's:
    // a quiet-hours retry landing on a capped broadcast would un-pause it, reserve nothing, and
    // pause it again — or worse, race a half-raised cap. Headroom is re-checked first, and a
    // capped broadcast stays parked until `resume` (which checks the same predicate) is called.
    if (broadcast.status === 'paused') {
      const account0 = await channelAccountRepository.findForOrg(
        job.orgId,
        broadcast.channelAccountId,
      );
      if (
        account0 === null ||
        !(await spendCapService.hasHeadroom(job.orgId, account0.billingCurrency)) ||
        // A past-due pause is un-resumable by a retry for exactly the reason the cap's is: the
        // condition does not clear by waiting, and un-pausing here would put the campaign back into
        // a state the next batch has to pause it out of again.
        (await dunningService.isDelinquent(job.orgId))
      ) {
        return { kind: 'done' };
      }
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

    // Sends through a WABA with no reported billing currency cannot be priced, and unpriceable
    // spend is not allowed — the same zero-by-default rule the reservation below enforces, caught
    // before a batch is claimed for it.
    if (account.billingCurrency === null) {
      await this.pauseForCap(
        job.orgId,
        broadcastId,
        'This WhatsApp account never reported its billing currency, so its sends cannot be priced against a spend cap.',
      );
      return { kind: 'done' };
    }
    const billingCurrency = account.billingCurrency;

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

      // Price this exact send before making it — the same (currency, country, category) lookup the
      // rater will repeat when the receipt lands. A recipient whose price cannot be named is
      // skipped, not waved through: under a zero-by-default cap, spend of unknowable size is spend
      // that was not granted. The skip's reason lands in the ledger like the consent skips do.
      const estimate = await spendCapService.estimateSendMicros({
        billingCurrency,
        recipientExternalId: recipient.externalId,
        pricingCategory: template.category ?? 'marketing',
      });
      if (estimate === null) {
        await broadcastRepository.settleRecipient({
          recipientId: recipient.id,
          status: 'skipped',
          reason:
            `No ${billingCurrency} rate is loaded for this recipient's country and the template's ` +
            'category, so this send cannot be priced against the spend cap.',
          providerMessageId: null,
          messageId: null,
          sentAt: null,
        });
        continue;
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
        billingCurrency,
        estimateMicros: estimate,
      });
      if (outcome.kind === 'cap_exhausted') {
        // The reservation found no headroom left. Like quiet hours, everyone not yet attempted goes
        // back to `pending` — including this recipient, whose send was refused before any attempt —
        // but UNLIKE quiet hours, NO retry is enqueued: a night ends on its own, a cap clears only
        // when someone grants headroom, and `resume` re-checks it.
        await broadcastRepository.releaseClaims(claimed.slice(i).map((r) => r.id));
        await this.pauseForCap(
          job.orgId,
          broadcastId,
          `The ${billingCurrency} spend cap is exhausted for this month. Raise it, then resume.`,
        );
        return { kind: 'done' };
      }
      if (outcome.kind === 'unknown') {
        // Unknown-outcome transport failure. Nothing says Meta is reachable for the rest of the
        // batch either, so stop here and let the queue's backoff decide when to try the NEXT batch —
        // this recipient stays `sending` and their reservation stays HELD, per the asymmetry above.
        await broadcastRepository.refreshCounts(broadcastId);
        return { kind: 'retry', reason: outcome.reason };
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
   * One recipient: record the message, reserve its money, send it, settle both.
   *
   * `{kind: 'settled'}` covers sent AND Meta-refused — both are decided. `{kind: 'unknown'}` is a
   * request that errored without Meta answering, so the message may or may not exist: the recipient
   * stays `sending`, the message stays `queued`, and the reservation stays HELD — all three say
   * honestly that nobody knows. `{kind: 'cap_exhausted'}` means the reservation was refused before
   * any attempt; the message row is settled `failed` as evidence, and the recipient is safe to
   * release because nothing was ever sent.
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
    billingCurrency: string;
    estimateMicros: bigint;
  }): Promise<
    { kind: 'settled' } | { kind: 'cap_exhausted' } | { kind: 'unknown'; reason: string }
  > {
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

    // No reservation, no send — this single statement is the cap. It sits between the message row
    // and the transport on purpose: the row gives the reservation its message_id, and a refusal
    // here has provably sent nothing yet.
    const reserved = await spendCapService.reserve({
      orgId: params.orgId,
      currency: params.billingCurrency,
      amountMicros: params.estimateMicros,
      messageId: message.id,
      broadcastId: params.broadcast.id,
    });
    if (reserved === 'insufficient') {
      await commerceInboxRepository.settleOutbound({
        orgId: params.orgId,
        messageId: message.id,
        status: 'failed',
        failureReason: 'Not sent: the spend cap left no headroom for this message.',
      });
      return { kind: 'cap_exhausted' };
    }

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
      return { kind: 'settled' };
    } catch (error) {
      if (error instanceof WhatsappSendRefusedError) {
        // Meta answered no, so no message reached this person — a certain, per-recipient failure
        // (bad number, policy refusal). Recorded and stepped past; the rest of the batch is fine.
        // The refusal is the one case the reservation asymmetry releases: the spend certainly
        // did not happen.
        await spendCapService.releaseForRefusedSend(message.id, error.message);
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
        return { kind: 'settled' };
      }

      const reason = error instanceof Error ? error.message : String(error);
      await broadcastRepository.noteSendingError(params.recipient.id, reason);
      logger.error('commerce: broadcast send outcome unknown', {
        orgId: params.orgId,
        broadcastId: params.broadcast.id,
        recipientId: params.recipient.id,
        error: reason,
      });
      // The reservation is deliberately NOT released — the money may have been spent.
      return { kind: 'unknown', reason };
    }
  }

  /** Park the broadcast for the cap. Nothing is enqueued: only granted headroom un-parks it. */
  private async pauseForCap(orgId: string, broadcastId: string, reason: string): Promise<void> {
    await broadcastRepository.transition({
      orgId,
      broadcastId,
      from: ['running'],
      to: 'paused',
      lastError: reason,
    });
    await broadcastRepository.refreshCounts(broadcastId);
    logger.info('commerce: broadcast paused by spend cap', { orgId, broadcastId });
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

export const broadcastSendHandler = new BroadcastSendHandler();
