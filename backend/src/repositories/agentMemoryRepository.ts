import type { AgentMemory, Rating, ResourceKind } from '@stewra/shared-types';
import { sql } from 'kysely';
import { db } from '../database/index.js';

interface MemoryRow {
  readonly id: string;
  readonly label: string;
  readonly kind: ResourceKind;
  readonly purpose: string;
  readonly exemplar: string;
  readonly guidance: string | null;
  readonly rating: Rating;
  readonly reward_score: number;
  readonly source: 'feedback' | 'user_edited';
  readonly visible: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Everything the recall step needs to format a few-shot exemplar. */
export interface RecalledMemory {
  readonly label: string;
  readonly exemplar: string;
  readonly guidance: string | null;
}

export interface UpsertMemoryFromFeedbackInput {
  readonly userId: string;
  readonly sourceInsightId: string;
  readonly label: string;
  readonly kind: ResourceKind;
  readonly purpose: string;
  readonly purposeNorm: string;
  readonly exemplar: string;
  readonly guidance: string | null;
  readonly rating: Rating;
  readonly rewardScore: number;
}

export interface UpdateMemoryPatch {
  readonly label?: string;
  readonly guidance?: string | null;
  readonly visible?: boolean;
}

const MODEL_COLUMNS = [
  'id',
  'label',
  'kind',
  'purpose',
  'exemplar',
  'guidance',
  'rating',
  'reward_score',
  'source',
  'visible',
  'created_at',
  'updated_at',
] as const;

export function toMemoryModel(row: MemoryRow): AgentMemory {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    purpose: row.purpose,
    exemplar: row.exemplar,
    guidance: row.guidance,
    rating: row.rating,
    rewardScore: row.reward_score,
    source: row.source,
    visible: row.visible,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class AgentMemoryRepository {
  /**
   * Create or refresh the learning derived from one insight's feedback. Upserts on the unique
   * (user_id, source_insight_id) so re-rating the same insight updates its learning in place.
   */
  async upsertFromFeedback(input: UpsertMemoryFromFeedbackInput): Promise<AgentMemory> {
    const row = await db
      .insertInto('agent_memory')
      .values({
        user_id: input.userId,
        source_insight_id: input.sourceInsightId,
        label: input.label,
        kind: input.kind,
        purpose: input.purpose,
        purpose_norm: input.purposeNorm,
        exemplar: input.exemplar,
        guidance: input.guidance,
        rating: input.rating,
        reward_score: input.rewardScore,
        source: 'feedback',
      })
      .onConflict((oc) =>
        oc.columns(['user_id', 'source_insight_id']).doUpdateSet({
          label: input.label,
          purpose: input.purpose,
          purpose_norm: input.purposeNorm,
          exemplar: input.exemplar,
          guidance: input.guidance,
          rating: input.rating,
          reward_score: input.rewardScore,
          updated_at: sql`now()`,
        }),
      )
      .returning(MODEL_COLUMNS)
      .executeTakeFirstOrThrow();
    return toMemoryModel(row);
  }

  /**
   * Lexical recall: the visible memories for this user + kind whose full-text vector matches the
   * query, ranked by text relevance then reward. Returns [] when the query has no searchable terms
   * (so an empty/stopword-only purpose never errors). `limit`/`minRank` come from config.
   */
  async recall(
    userId: string,
    kind: ResourceKind,
    query: string,
    limit: number,
    minRank: number,
  ): Promise<ReadonlyArray<RecalledMemory>> {
    if (query.trim().length === 0) {
      return [];
    }
    const tsquery = sql`websearch_to_tsquery('english', ${query})`;
    const rank = sql<number>`ts_rank(search_vector, ${tsquery})`;
    return db
      .selectFrom('agent_memory')
      .select(['label', 'exemplar', 'guidance'])
      .where('user_id', '=', userId)
      .where('kind', '=', kind)
      .where('visible', '=', true)
      .where(sql<boolean>`search_vector @@ ${tsquery}`)
      .where(sql<boolean>`${rank} >= ${minRank}`)
      .orderBy(rank, 'desc')
      .orderBy('reward_score', 'desc')
      .limit(limit)
      .execute();
  }

  /** List the user's memories for the Memory screen, newest first, with optional filters. */
  async list(
    userId: string,
    filters: { readonly search?: string; readonly kind?: ResourceKind },
  ): Promise<ReadonlyArray<AgentMemory>> {
    let q = db.selectFrom('agent_memory').select(MODEL_COLUMNS).where('user_id', '=', userId);
    if (filters.kind) {
      q = q.where('kind', '=', filters.kind);
    }
    if (filters.search && filters.search.trim().length > 0) {
      q = q.where(sql<boolean>`search_vector @@ websearch_to_tsquery('english', ${filters.search})`);
    }
    const rows = await q.orderBy('updated_at', 'desc').execute();
    return rows.map(toMemoryModel);
  }

  async findByIdForUser(id: string, userId: string): Promise<AgentMemory | undefined> {
    const row = await db
      .selectFrom('agent_memory')
      .select(MODEL_COLUMNS)
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? toMemoryModel(row) : undefined;
  }

  /** Apply a partial edit the user owns. Only the provided fields change (conditional set). */
  async update(id: string, userId: string, patch: UpdateMemoryPatch): Promise<AgentMemory> {
    const row = await db
      .updateTable('agent_memory')
      .set({
        updated_at: sql`now()`,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.guidance !== undefined ? { guidance: patch.guidance } : {}),
        ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
      })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returning(MODEL_COLUMNS)
      .executeTakeFirstOrThrow();
    return toMemoryModel(row);
  }

  /** Real delete (memory-and-learning.md §5 — no soft-delete). Returns whether a row was removed. */
  async delete(id: string, userId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('agent_memory')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Remove the learning tied to one insight — used when re-rating downgrades it below the bar. */
  async deleteBySourceInsight(userId: string, insightId: string): Promise<void> {
    await db
      .deleteFrom('agent_memory')
      .where('user_id', '=', userId)
      .where('source_insight_id', '=', insightId)
      .execute();
  }

  /** Forget-on-disconnect: purge all memories a user built from a given source kind. */
  async deleteByKind(userId: string, kind: ResourceKind): Promise<number> {
    const result = await db
      .deleteFrom('agent_memory')
      .where('user_id', '=', userId)
      .where('kind', '=', kind)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

export const agentMemoryRepository = new AgentMemoryRepository();
