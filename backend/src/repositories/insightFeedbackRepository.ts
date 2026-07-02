import type { InsightFeedback, Rating } from '@stewra/shared-types';
import { sql } from 'kysely';
import { db } from '../database/index';

export interface InsightFeedbackRow {
  readonly id: string;
  readonly user_id: string;
  readonly insight_id: string;
  readonly rating: Rating;
  readonly reward_score: number;
  readonly comment: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface UpsertFeedbackInput {
  readonly userId: string;
  readonly insightId: string;
  readonly rating: Rating;
  readonly rewardScore: number;
  readonly comment: string | null;
}

/** Map a DB row to the public InsightFeedback model. */
export function toFeedbackModel(row: InsightFeedbackRow): InsightFeedback {
  return {
    id: row.id,
    insightId: row.insight_id,
    rating: row.rating,
    rewardScore: row.reward_score,
    comment: row.comment,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const COLUMNS = [
  'id',
  'user_id',
  'insight_id',
  'rating',
  'reward_score',
  'comment',
  'created_at',
  'updated_at',
] as const;

export class InsightFeedbackRepository {
  /**
   * Record (or replace) the user's feedback on one insight. Upserts on the unique
   * (user_id, insight_id) — a user can change their mind and the latest verdict wins.
   */
  async upsert(input: UpsertFeedbackInput): Promise<InsightFeedbackRow> {
    return db
      .insertInto('insight_feedback')
      .values({
        user_id: input.userId,
        insight_id: input.insightId,
        rating: input.rating,
        reward_score: input.rewardScore,
        comment: input.comment,
      })
      .onConflict((oc) =>
        oc.columns(['user_id', 'insight_id']).doUpdateSet({
          rating: input.rating,
          reward_score: input.rewardScore,
          comment: input.comment,
          updated_at: sql`now()`,
        }),
      )
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
  }
}

export const insightFeedbackRepository = new InsightFeedbackRepository();
