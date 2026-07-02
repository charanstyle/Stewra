import type { AgentInsight, ResourceKind } from '@stewra/shared-types';
import { db } from '../database/index';

/** A persisted insight row. `factsUsed` is reserved (null for now). */
export interface AgentInsightRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: ResourceKind;
  readonly purpose: string;
  readonly purposeNorm: string;
  readonly summary: string;
  readonly modelId: string;
  readonly createdAt: Date;
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
}

export const agentInsightRepository = new AgentInsightRepository();
