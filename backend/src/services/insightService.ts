import type { AgentInsight, ResourceKind } from '@stewra/shared-types';
import { agentRuntime } from '../agent-host/agentHost';
import { auditWriter } from '../control-plane/audit/auditWriter';

/**
 * Runs the agent's advice-only loop and then — in the CONTROL PLANE, not the agent — records the
 * resulting insight to the append-only audit log so it shows in the activity feed. The agent has no
 * capability to write audit/insight rows itself; this preserves "the model is never a trusted
 * enforcement point" for memory/audit writes too.
 */
export class InsightService {
  async generateAndRecord(
    userId: string,
    kind: ResourceKind,
    purpose: string,
  ): Promise<AgentInsight> {
    const insight = await agentRuntime.produceInsight(userId, kind, purpose);

    await auditWriter.write({
      userId,
      action: 'insight',
      resourceType: kind,
      resourceId: null,
      summary: insight.summary,
      success: true,
      metadata: { purpose },
    });

    return insight;
  }
}

export const insightService = new InsightService();
