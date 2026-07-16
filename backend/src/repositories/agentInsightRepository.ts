import type { AgentInsight, ResourceKind } from '@stewra/shared-types';
import { sql } from 'kysely';
import { db } from '../database/index.js';

/** A persisted insight row. `factsUsed` is reserved (null for now). */
export interface AgentInsightRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: ResourceKind;
  readonly purpose: string;
  readonly purposeNorm: string;
  readonly summary: string;
  readonly modelId: string;
  /** First-impression timestamp (implicit engagement); null until the insight is surfaced. */
  readonly seenAt: Date | null;
  /** When the user dismissed the insight without rating it; null until dismissed. */
  readonly dismissedAt: Date | null;
  readonly createdAt: Date;
}

/** The engagement timestamps returned after a seen/dismiss mark. */
export interface InsightEngagement {
  readonly seenAt: Date | null;
  readonly dismissedAt: Date | null;
}

export interface NewAgentInsightRow {
  readonly userId: string;
  readonly kind: ResourceKind;
  readonly purpose: string;
  readonly purposeNorm: string;
  readonly summary: string;
  readonly modelId: string;
}

/** The runtime output plus the id the control plane assigned when it recorded the insight. */
export interface RecordedInsight {
  readonly insight: AgentInsight;
  readonly insightId: string;
}

const COLUMNS = [
  'id',
  'user_id',
  'kind',
  'purpose',
  'purpose_norm',
  'summary',
  'model_id',
  'seen_at',
  'dismissed_at',
  'created_at',
] as const;

type SelectedRow = {
  readonly id: string;
  readonly user_id: string;
  readonly kind: ResourceKind;
  readonly purpose: string;
  readonly purpose_norm: string;
  readonly summary: string;
  readonly model_id: string;
  readonly seen_at: Date | null;
  readonly dismissed_at: Date | null;
  readonly created_at: Date;
};

function toRow(row: SelectedRow): AgentInsightRow {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    purpose: row.purpose,
    purposeNorm: row.purpose_norm,
    summary: row.summary,
    modelId: row.model_id,
    seenAt: row.seen_at,
    dismissedAt: row.dismissed_at,
    createdAt: row.created_at,
  };
}

export class AgentInsightRepository {
  /** Persist a produced insight and return the stored row (with its new id). */
  async create(input: NewAgentInsightRow): Promise<AgentInsightRow> {
    const row = await db
      .insertInto('agent_insights')
      .values({
        user_id: input.userId,
        kind: input.kind,
        purpose: input.purpose,
        purpose_norm: input.purposeNorm,
        summary: input.summary,
        model_id: input.modelId,
        facts_used: null,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return toRow(row);
  }

  /** Fetch one insight scoped to its owner (so a user can only rate their own). */
  async findByIdForUser(id: string, userId: string): Promise<AgentInsightRow | undefined> {
    const row = await db
      .selectFrom('agent_insights')
      .select(COLUMNS)
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? toRow(row) : undefined;
  }

  /**
   * Record the first impression of an insight, scoped to its owner. First-write-wins: `coalesce`
   * keeps the earliest `seen_at`, so a re-render never overwrites the original impression. Returns
   * the resulting timestamps, or undefined when the insight isn't the user's / doesn't exist.
   */
  async markSeen(id: string, userId: string): Promise<InsightEngagement | undefined> {
    const row = await db
      .updateTable('agent_insights')
      .set({ seen_at: sql`coalesce(seen_at, now())` })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returning(['seen_at as seenAt', 'dismissed_at as dismissedAt'])
      .executeTakeFirst();
    return row ? { seenAt: row.seenAt, dismissedAt: row.dismissedAt } : undefined;
  }

  /**
   * Record the user dismissing an insight, scoped to its owner. First-write-wins on `dismissed_at`
   * so a repeat dismiss is idempotent (the service reads prior state to decide whether the implicit
   * signal should fire only once). Returns the resulting timestamps, or undefined when not found.
   */
  async markDismissed(id: string, userId: string): Promise<InsightEngagement | undefined> {
    const row = await db
      .updateTable('agent_insights')
      .set({ dismissed_at: sql`coalesce(dismissed_at, now())` })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returning(['seen_at as seenAt', 'dismissed_at as dismissedAt'])
      .executeTakeFirst();
    return row ? { seenAt: row.seenAt, dismissedAt: row.dismissedAt } : undefined;
  }
}

export const agentInsightRepository = new AgentInsightRepository();
