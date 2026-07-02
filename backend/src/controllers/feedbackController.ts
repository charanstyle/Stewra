import type { Request, Response } from 'express';
import { z } from 'zod';
import type { SubmitFeedbackResponse } from '@stewra/shared-types';
import { BaseController } from './baseController';
import { feedbackService } from '../services/feedbackService';
import { parse } from '../utils/validate';

const submitSchema = z.object({
  rating: z.enum(['poor', 'average', 'good', 'excellent', 'outstanding']),
  // The optional free-text ("any other text"). Trimmed; blank collapses to no comment.
  comment: z.string().trim().max(2000).optional(),
});

const paramsSchema = z.object({
  insightId: z.string().uuid(),
});

class FeedbackController extends BaseController {
  /** POST /insights/:insightId/feedback — record the user's verdict on one insight. */
  async submit(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('submit() requires requireAuth middleware');
      }
      const { insightId } = parse(paramsSchema, req.params);
      const { rating, comment } = parse(submitSchema, req.body);
      const feedback = await feedbackService.submitFeedback(
        userId,
        insightId,
        rating,
        comment && comment.length > 0 ? comment : null,
      );
      const body: SubmitFeedbackResponse = { feedback };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'FeedbackController.submit');
    }
  }
}

export const feedbackController = new FeedbackController();
