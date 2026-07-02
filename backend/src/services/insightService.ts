import type { ResourceKind } from '@stewra/shared-types';
import { agentRuntime } from '../agent-host/agentHost';
import { auditWriter } from '../control-plane/audit/auditWriter';
import { config } from '../config/unifiedConfig';
import { agentInsightRepository } from '../repositories/agentInsightRepository';
import type { RecordedInsight } from '../repositories/agentInsightRepository';
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
}

export const insightService = new InsightService();
