import type { InsightFeedback, Rating } from '@stewra/shared-types';
import { RATING_REWARD } from '@stewra/shared-types';
import { auditWriter } from '../control-plane/audit/auditWriter';
import { agentInsightRepository } from '../repositories/agentInsightRepository';
import {
  insightFeedbackRepository,
  toFeedbackModel,
} from '../repositories/insightFeedbackRepository';
import { memoryService } from './memoryService';
import { processMemoryService } from './processMemoryService';
import { NotFoundError } from '../utils/errors';

/**
 * Records the user's verdict on an insight (the reward signal) and — because the user AUTHORED it —
 * turns qualifying feedback into a user-visible memory the agent can reuse. Runs in the control
 * plane: the agent never writes feedback or memory itself.
 */
export class FeedbackService {
  async submitFeedback(
    userId: string,
    insightId: string,
    rating: Rating,
    comment: string | null,
  ): Promise<InsightFeedback> {
    // Scope the insight to its owner — a user may only rate their own insight, and a bad id is a 404.
    const insight = await agentInsightRepository.findByIdForUser(insightId, userId);
    if (!insight) {
      throw new NotFoundError('Insight not found');
    }

    const rewardScore = RATING_REWARD[rating];
    const row = await insightFeedbackRepository.upsert({
      userId,
      insightId,
      rating,
      rewardScore,
      comment,
    });

    await auditWriter.write({
      userId,
      action: 'feedback',
      resourceType: insight.kind,
      resourceId: insightId,
      summary: `Rated an insight "${rating}"`,
      success: true,
      metadata: { rating, rewardScore, hasComment: comment !== null },
    });

    // Because the user authored this verdict, turn a positive or free-text rating into a named,
    // searchable, user-visible memory the agent can reuse on future similar tasks (auto-saved with
    // full visibility, never silent — memory-and-learning.md §3).
    await memoryService.captureFromFeedback(userId, insight, {
      rating,
      rewardScore,
      comment,
    });

    // A free-text comment may also imply a generalized process/style rule ("keep it shorter", "cc my
    // manager"). Extract any such candidates deterministically and land them as PROPOSED rules for the
    // user to confirm — the model never asserts a style rule silently (§3).
    await processMemoryService.captureFromFeedbackComment(userId, insight.kind, comment);

    // The Sutton reward step: the rating grounds the process/style rules that shaped this insight's
    // domain — a positive verdict reinforces them, a negative one decays them (an override that
    // eventually drops the rule from recall). Pure counter movement on the rules recall actually used.
    await processMemoryService.reinforceForFeedback(userId, insight.kind, rewardScore);

    return toFeedbackModel(row);
  }
}

export const feedbackService = new FeedbackService();
