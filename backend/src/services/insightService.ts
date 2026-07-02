import type { InsightEngagementResponse, ResourceKind } from '@stewra/shared-types';
import { agentRuntime } from '../agent-host/agentHost';
import { auditWriter } from '../control-plane/audit/auditWriter';
import { config } from '../config/unifiedConfig';
import { agentInsightRepository } from '../repositories/agentInsightRepository';
import type { InsightEngagement, RecordedInsight } from '../repositories/agentInsightRepository';
import { insightFeedbackRepository } from '../repositories/insightFeedbackRepository';
import { processMemoryService } from './processMemoryService';
import { NotFoundError } from '../utils/errors';
import { normalizeText } from '../utils/text';

/**
 * Runs the agent's advice-only loop and then — in the CONTROL PLANE, not the agent — PERSISTS the
 * insight (so the user can later rate it and so a good one becomes a reusable exemplar) and records
 * it to the append-only audit log so it shows in the activity feed. The agent has no capability to
 * write insight/audit rows itself; this preserves "the model is never a trusted enforcement point"
 * for those writes too.
 */
export class InsightService {
  async generateAndRecord(
    userId: string,
    kind: ResourceKind,
    purpose: string,
  ): Promise<RecordedInsight> {
    const insight = await agentRuntime.produceInsight(userId, kind, purpose);

    const stored = await agentInsightRepository.create({
      userId,
      kind,
      purpose,
      purposeNorm: normalizeText(purpose),
      summary: insight.summary,
      modelId: config.model.modelId,
    });

    await auditWriter.write({
      userId,
      action: 'insight',
      resourceType: kind,
      resourceId: stored.id,
      summary: insight.summary,
      success: true,
      metadata: { purpose },
    });

    return { insight, insightId: stored.id };
  }

  /**
   * Record that an insight was surfaced to the user — the passive impression signal. First-write-wins
   * on `seen_at` (a re-render never rewrites the original), scoped to the owner (a foreign/absent id
   * is a 404). Audited as `view` so an at-a-glance impression is visible in the activity feed. No
   * reward effect — merely seeing advice is neutral.
   */
  async markSeen(userId: string, insightId: string): Promise<InsightEngagementResponse> {
    const insight = await agentInsightRepository.findByIdForUser(insightId, userId);
    if (!insight) {
      throw new NotFoundError('Insight not found');
    }
    const engagement = await agentInsightRepository.markSeen(insightId, userId);
    // markSeen resolves for the same owner-scoped row we just loaded; treat a miss defensively.
    if (!engagement) {
      throw new NotFoundError('Insight not found');
    }

    await auditWriter.write({
      userId,
      action: 'view',
      resourceType: insight.kind,
      resourceId: insightId,
      summary: 'Saw an insight',
      success: true,
      metadata: { alreadySeen: insight.seenAt !== null },
    });

    return this.toEngagementResponse(insightId, engagement);
  }

  /**
   * Record the user dismissing an insight without rating it — the implicit "not useful" signal.
   * Scoped to the owner (a foreign/absent id is a 404). Audited as `dismiss`. On the FIRST dismiss of
   * an unrated insight it applies a weak negative to the style rules that shaped that domain's advice
   * (`reinforceForImplicitSignal`), so a shown-and-ignored insight finally teaches something. Guarded
   * both ways so it can't double-count: skipped if the user already rated the insight (explicit wins)
   * or already dismissed it once (idempotent). Config can zero the reward to keep this telemetry-only.
   */
  async markDismissed(userId: string, insightId: string): Promise<InsightEngagementResponse> {
    const insight = await agentInsightRepository.findByIdForUser(insightId, userId);
    if (!insight) {
      throw new NotFoundError('Insight not found');
    }
    const firstDismiss = insight.dismissedAt === null;
    const engagement = await agentInsightRepository.markDismissed(insightId, userId);
    if (!engagement) {
      throw new NotFoundError('Insight not found');
    }

    await auditWriter.write({
      userId,
      action: 'dismiss',
      resourceType: insight.kind,
      resourceId: insightId,
      summary: 'Dismissed an insight',
      success: true,
      metadata: { firstDismiss },
    });

    // The implicit reward fires once, and only when the user hasn't given an explicit verdict — an
    // explicit rating always dominates the weaker passive signal.
    if (firstDismiss) {
      const alreadyRated = await insightFeedbackRepository.existsForInsight(userId, insightId);
      if (!alreadyRated) {
        await processMemoryService.reinforceForImplicitSignal(
          userId,
          insight.kind,
          config.processMemory.implicitDismissReward,
        );
      }
    }

    return this.toEngagementResponse(insightId, engagement);
  }

  /** Shape the repo's engagement timestamps into the API response (ISO strings, nulls preserved). */
  private toEngagementResponse(
    insightId: string,
    engagement: InsightEngagement,
  ): InsightEngagementResponse {
    return {
      insightId,
      seenAt: engagement.seenAt ? engagement.seenAt.toISOString() : null,
      dismissedAt: engagement.dismissedAt ? engagement.dismissedAt.toISOString() : null,
    };
  }
}

export const insightService = new InsightService();
