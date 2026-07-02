import type { InsightFeedback, Rating } from '../models/feedback';

/**
 * Submit (or update) the user's feedback on one insight. The insight is identified by the path
 * param, not the body. `comment` is the optional free-text — the denser learning signal.
 */
export interface SubmitFeedbackRequest {
  readonly rating: Rating;
  readonly comment?: string;
}

export interface SubmitFeedbackResponse {
  readonly feedback: InsightFeedback;
}
