import type {
  BroadcastCostForecast,
  BroadcastRecipient,
  BroadcastRecipientStatus,
  CommerceBroadcast,
  PreviewBroadcastResponse,
} from '@stewra/shared-types';
import { broadcastRepository } from '../repositories/broadcastRepository.js';
import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { segmentRepository } from '../repositories/segmentRepository.js';
import { audienceService } from './audienceService.js';
import { countryCallingCode } from './callingCodes.js';
import { templateService } from './templateService.js';
import { config } from '../../config/unifiedConfig.js';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../../utils/errors.js';

/**
 * Scheduling and steering broadcasts. The actual sending lives in the job handlers —
 * `broadcastDispatchHandler` materializes the audience, `broadcastSendHandler` walks it — because a
 * campaign must survive the process that scheduled it dying.
 *
 * The scheduling mechanism is the job queue itself: creating a broadcast enqueues its dispatch job
 * with `runAfter = scheduledFor`, so there is no sweep that could miss a minute and no second copy
 * of "is it time yet" logic. Cancellation does not dequeue — the dispatch job runs, finds the
 * broadcast is no longer `scheduled`, and does nothing, which is cheaper and simpler than making
 * enqueue and cancel race each other.
 */
class BroadcastService {
  /**
   * Refuse to put work on a queue nothing is draining.
   *
   * `startCommerceScheduler` returns before `commerceWorker.start()` when the integration is off, and
   * it argues there that enqueue and drain must not be separable — a deploy that enqueues without
   * draining looks healthy because every enqueue succeeds. That argument does not stop at the
   * scheduler: with the flag off, `create` would write a broadcast, enqueue its dispatch, answer 201,
   * and the campaign would sit in `commerce_jobs` forever. The client would have been told their
   * campaign was scheduled, which is the one thing that must never be said falsely here.
   *
   * A 503 rather than a 400: nothing about the request is wrong, and it will work unchanged once the
   * operator turns the integration on. {@link ServiceUnavailableError} exists for exactly this shape.
   */
  private assertDispatchable(): void {
    if (!config.metaCommerce.enabled) {
      throw new ServiceUnavailableError(
        'Broadcasts are not enabled on this install, so a campaign scheduled now would never be ' +
          'sent. Set META_COMMERCE_ENABLED=true and bring up the commerce worker first.',
      );
    }
  }

  async list(orgId: string, limit: number): Promise<CommerceBroadcast[]> {
    return broadcastRepository.listForOrg(orgId, limit);
  }

  async get(orgId: string, broadcastId: string): Promise<CommerceBroadcast> {
    const broadcast = await broadcastRepository.findById(orgId, broadcastId);
    if (broadcast === null) throw new NotFoundError('Broadcast not found');
    return broadcast;
  }

  /**
   * Schedule a campaign. Everything checkable now is checked now — the template's approval and
   * variable count, the account, the segment — because "your campaign never started" discovered on
   * Friday morning is strictly worse than a refusal on Monday. The dispatch job re-checks the
   * template anyway: four days is plenty of time for Meta to pause it.
   */
  async create(params: {
    orgId: string;
    createdByUserId: string;
    name: string;
    channelAccountId: string;
    segmentId: string;
    templateId: string;
    variables: readonly string[];
    scheduledFor: Date;
  }): Promise<CommerceBroadcast> {
    this.assertDispatchable();

    const account = await channelAccountRepository.findForOrg(params.orgId, params.channelAccountId);
    if (account === null) throw new NotFoundError('Channel account not found');
    if (account.platform !== 'whatsapp_cloud') {
      throw new ValidationError('Validation failed', [
        {
          field: 'channelAccountId',
          message: `Broadcasts send templates, which exist on WhatsApp only; this account is ${account.platform}.`,
        },
      ]);
    }
    if (account.status !== 'active') {
      throw new ValidationError('Validation failed', [
        {
          field: 'channelAccountId',
          message: `This channel is ${account.status}${account.errorDetail === null ? '' : ` (${account.errorDetail})`}. Reconnect it before scheduling.`,
        },
      ]);
    }

    // Existence checks double as tenancy checks — both lookups are org-scoped.
    await audienceService.getSegment(params.orgId, params.segmentId);
    const template = await templateService.assertSendable(
      params.orgId,
      params.templateId,
      params.variables.length,
    );
    if (template.channelAccountId !== account.id) {
      throw new ValidationError('Validation failed', [
        {
          field: 'templateId',
          message:
            `Template "${template.name}" belongs to a different WhatsApp account. ` +
            'Meta will not let one account send another account\'s templates.',
        },
      ]);
    }

    const broadcast = await broadcastRepository.create({
      orgId: params.orgId,
      channelAccountId: params.channelAccountId,
      name: params.name,
      segmentId: params.segmentId,
      templateId: params.templateId,
      variables: params.variables,
      scheduledFor: params.scheduledFor,
      createdByUserId: params.createdByUserId,
    });

    // The dedupe key makes this exactly-once per broadcast: a retried create request that somehow
    // reached here twice would find the second enqueue refused rather than dispatching twice.
    await jobRepository.enqueue({
      orgId: params.orgId,
      kind: 'broadcast_dispatch',
      payload: { broadcastId: broadcast.id },
      runAfter: params.scheduledFor,
      dedupeKey: `broadcast_dispatch:${broadcast.id}`,
    });

    return broadcast;
  }

  /**
   * What this campaign would reach and be billed as, answered live and priced by count, not money —
   * see {@link BroadcastCostForecast} for why no currency amount appears.
   */
  async preview(params: {
    orgId: string;
    segmentId: string;
    templateId: string;
  }): Promise<PreviewBroadcastResponse> {
    const segment = await audienceService.getSegment(params.orgId, params.segmentId);
    const template = await templateService.get(params.orgId, params.templateId);

    const [audience, prefixCounts] = await Promise.all([
      audienceService.previewSegment(params.orgId, segment.definition, 10),
      segmentRepository.countSendableByPhonePrefix(params.orgId, segment.definition),
    ]);

    // Fold the raw three-digit prefixes onto actual calling codes. Members whose number names no
    // country are left out of the per-country table but stay inside `billableMessages` — the
    // difference between the total and the table is visible rather than papered over.
    const byCountryCode: Record<string, number> = {};
    for (const { prefix, count } of prefixCounts) {
      if (prefix === null) continue;
      const code = countryCallingCode(`+${prefix}`);
      if (code === null) continue;
      byCountryCode[code] = (byCountryCode[code] ?? 0) + count;
    }

    const forecast: BroadcastCostForecast = {
      billableMessages: audience.sendable,
      category: template.category,
      byCountryCode,
    };
    return { audience, forecast };
  }

  /**
   * Stop a broadcast. Scheduled → nothing was sent; running or paused → the send chain notices at
   * its next batch and stops. Nothing can unsend, and the response's counts say what already went.
   */
  async cancel(orgId: string, broadcastId: string): Promise<CommerceBroadcast> {
    const cancelled = await broadcastRepository.transition({
      orgId,
      broadcastId,
      from: ['scheduled', 'running', 'paused'],
      to: 'cancelled',
    });
    if (cancelled !== null) return cancelled;

    const current = await this.get(orgId, broadcastId);
    throw new ConflictError(`This broadcast is already ${current.status} and cannot be cancelled.`);
  }

  /** Put a paused broadcast back on the queue, immediately, without waiting for the retry cadence. */
  async resume(orgId: string, broadcastId: string): Promise<CommerceBroadcast> {
    // Guarded for the same reason as `create`, and checked before the transition rather than after:
    // moving a broadcast to `running` and then failing to enqueue would leave it in a state whose
    // name says work is happening while the queue holds nothing.
    this.assertDispatchable();

    const resumed = await broadcastRepository.transition({
      orgId,
      broadcastId,
      from: ['paused'],
      to: 'running',
      lastError: null,
    });
    if (resumed === null) {
      const current = await this.get(orgId, broadcastId);
      throw new ConflictError(`This broadcast is ${current.status}; only a paused one can be resumed.`);
    }

    await jobRepository.enqueue({
      orgId,
      kind: 'broadcast_send',
      payload: { broadcastId },
    });
    return resumed;
  }

  async listRecipients(params: {
    orgId: string;
    broadcastId: string;
    status: BroadcastRecipientStatus | undefined;
    limit: number;
    offset: number;
  }): Promise<BroadcastRecipient[]> {
    // Confirms the broadcast is this org's before reading its ledger.
    await this.get(params.orgId, params.broadcastId);
    return broadcastRepository.listRecipients(params);
  }
}

export const broadcastService = new BroadcastService();
