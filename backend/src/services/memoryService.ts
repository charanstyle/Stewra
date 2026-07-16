import type { AgentMemory, Rating, ResourceKind } from '@stewra/shared-types';
import { POSITIVE_RATINGS } from '@stewra/shared-types';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { agentMemoryRepository } from '../repositories/agentMemoryRepository.js';
import type { UpdateMemoryPatch } from '../repositories/agentMemoryRepository.js';
import type { AgentInsightRow } from '../repositories/agentInsightRepository.js';
import { config } from '../config/unifiedConfig.js';
import { buildMemoryLabel } from '../utils/memoryLabel.js';
import { normalizeText } from '../utils/text.js';
import { NotFoundError } from '../utils/errors.js';
import { policyEngine, KIND_TO_PROVIDER } from '../control-plane/policy/policy.js';

/** The connected-source kinds a learning can be scoped to (memory itself is never a scope). */
const SCOPE_KINDS: ReadonlyArray<Exclude<ResourceKind, 'memory'>> = ['calendar', 'gmail', 'money'];

/** The feedback facts the capture step needs (a subset of the full feedback row). */
export interface FeedbackForMemory {
  readonly rating: Rating;
  readonly rewardScore: number;
  readonly comment: string | null;
}

/**
 * The user-owned learning store. The control plane (never the agent) writes it. Two jobs:
 *  - `captureFromFeedback`: turn a positive OR free-text verdict into a named, searchable, visible
 *    memory (auto-saved because the USER authored the feedback — memory-and-learning.md §3).
 *  - `recall`: lexically fetch the best past-success exemplars for a new task, formatted for the
 *    model. Recall runs through the broker, so it obeys the one brokered-access path.
 */
export class MemoryService {
  /** A verdict is worth remembering when it's positive, or when the user left free-text guidance. */
  private qualifies(feedback: FeedbackForMemory): boolean {
    const positive = POSITIVE_RATINGS.includes(feedback.rating);
    const hasComment = feedback.comment !== null && feedback.comment.length > 0;
    return positive || hasComment;
  }

  /**
   * Persist (or refresh) the learning for one rated insight. If a re-rating no longer qualifies
   * (e.g. downgraded to "poor" with no comment), the prior learning is removed so we never replay a
   * result the user is no longer happy with. Returns the saved memory, or null when nothing is kept.
   */
  async captureFromFeedback(
    userId: string,
    insight: AgentInsightRow,
    feedback: FeedbackForMemory,
  ): Promise<AgentMemory | null> {
    if (!this.qualifies(feedback)) {
      await agentMemoryRepository.deleteBySourceInsight(userId, insight.id);
      return null;
    }

    const label = buildMemoryLabel(insight.kind, insight.purpose, feedback.rating);
    const guidance = feedback.comment !== null && feedback.comment.length > 0 ? feedback.comment : null;

    const memory = await agentMemoryRepository.upsertFromFeedback({
      userId,
      sourceInsightId: insight.id,
      label,
      kind: insight.kind,
      purpose: insight.purpose,
      purposeNorm: insight.purposeNorm,
      exemplar: insight.summary,
      guidance,
      rating: feedback.rating,
      rewardScore: feedback.rewardScore,
    });

    await auditWriter.write({
      userId,
      action: 'learn',
      resourceType: insight.kind,
      resourceId: memory.id,
      summary: `Saved a learning: ${label}`,
      success: true,
      metadata: { rating: feedback.rating, label },
    });

    return memory;
  }

  /**
   * Return the best past-success exemplars for a new task, as short strings the agent can drop into
   * its prompt. Empty when nothing relevant is stored. Scoped to the same resource kind so exemplars
   * stay on-topic; ranked by lexical relevance to the purpose, then reward.
   */
  async recall(userId: string, kind: ResourceKind, purpose: string): Promise<ReadonlyArray<string>> {
    const memories = await agentMemoryRepository.recall(
      userId,
      kind,
      normalizeText(purpose),
      config.memory.recallLimit,
      config.memory.recallMinRank,
    );
    return memories.map((m) =>
      m.guidance !== null && m.guidance.length > 0
        ? `[${m.label}] ${m.exemplar} — guidance: ${m.guidance}`
        : `[${m.label}] ${m.exemplar}`,
    );
  }

  /**
   * List the user's own memories for the Memory screen ("things I've learned about you"). Optional
   * lexical `search` and `kind` filters. This is a plain owner read of the user's store — no broker,
   * no policy — surfaced so the learning stays fully visible and auditable (memory-and-learning.md §5).
   */
  async listMemories(
    userId: string,
    filters: { readonly search?: string; readonly kind?: ResourceKind },
  ): Promise<ReadonlyArray<AgentMemory>> {
    return agentMemoryRepository.list(userId, filters);
  }

  /**
   * Apply a user's edit to one of their memories (rename the searchable label, revise/clear guidance,
   * or toggle visibility). Scoped to the owner — a foreign or missing id is a 404. The user authoring
   * the change is itself a learning signal, so it's audited as 'learn' with source 'user_edited'.
   */
  async updateMemory(
    userId: string,
    id: string,
    patch: UpdateMemoryPatch,
  ): Promise<AgentMemory> {
    const existing = await agentMemoryRepository.findByIdForUser(id, userId);
    if (!existing) {
      throw new NotFoundError('Memory not found');
    }

    const memory = await agentMemoryRepository.update(id, userId, patch);

    await auditWriter.write({
      userId,
      action: 'learn',
      resourceType: memory.kind,
      resourceId: memory.id,
      summary: `Edited a learning: ${memory.label}`,
      success: true,
      metadata: {
        label: memory.label,
        relabeled: patch.label !== undefined,
        guidanceChanged: patch.guidance !== undefined,
        visible: memory.visible,
      },
    });

    return memory;
  }

  /**
   * Really delete one memory the user owns (no soft-delete — memory-and-learning.md §5). Scoped to
   * the owner; a foreign or missing id is a 404. The removal is audited as 'forget' so deletions are
   * as visible as writes.
   */
  async deleteMemory(userId: string, id: string): Promise<void> {
    const existing = await agentMemoryRepository.findByIdForUser(id, userId);
    if (!existing) {
      throw new NotFoundError('Memory not found');
    }

    await agentMemoryRepository.delete(id, userId);

    await auditWriter.write({
      userId,
      action: 'forget',
      resourceType: existing.kind,
      resourceId: id,
      summary: `Forgot a learning: ${existing.label}`,
      success: true,
      metadata: { label: existing.label },
    });
  }

  /**
   * Forget-on-disconnect: purge every memory a user built from a source they just revoked, so
   * disconnecting a source leaves nothing derived from it behind. Audited as a single 'forget' for
   * the kind. Returns how many were removed.
   */
  async forgetByKind(userId: string, kind: ResourceKind): Promise<number> {
    const removed = await agentMemoryRepository.deleteByKind(userId, kind);
    if (removed > 0) {
      await auditWriter.write({
        userId,
        action: 'forget',
        resourceType: kind,
        resourceId: null,
        summary: `Forgot ${removed} learning(s) from disconnected ${kind}`,
        success: true,
        metadata: { kind, removed },
      });
    }
    return removed;
  }

  /**
   * Reconcile the learning store after a user disconnects a source. Memory is scoped by resource KIND
   * (not by individual account), and one provider can authorize several kinds (Google → calendar +
   * gmail), so a kind is forgotten only once NO active connection still authorizes it — a user with a
   * second Google account keeps their calendar/gmail learnings. The policy engine is the single source
   * of truth for what remains connected, so the provider→kind mapping isn't duplicated here. Returns
   * how many learnings were removed across all affected kinds.
   */
  async forgetForDisconnectedProvider(userId: string, provider: string): Promise<number> {
    const affectedKinds = SCOPE_KINDS.filter((kind) => KIND_TO_PROVIDER[kind] === provider);

    let removed = 0;
    for (const kind of affectedKinds) {
      const decision = await policyEngine.canRead(userId, kind);
      if (!decision.allowed) {
        removed += await this.forgetByKind(userId, kind);
      }
    }
    return removed;
  }
}

export const memoryService = new MemoryService();
