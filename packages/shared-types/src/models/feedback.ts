import type { ISODateString, UUID } from '../common/base';

/**
 * The user's graded verdict on a produced insight. Five levels, worst → best. This is the crude but
 * clear *reward* signal (Sutton's reward hypothesis): a graded rating the learning loop can rank and
 * threshold on. The richer, denser signal is the optional free-text `comment` alongside it.
 */
export type Rating = 'poor' | 'average' | 'good' | 'excellent' | 'outstanding';

/** Every rating, worst → best. Single source of truth for validators and UI (never re-typed). */
export const RATINGS: ReadonlyArray<Rating> = [
  'poor',
  'average',
  'good',
  'excellent',
  'outstanding',
];

/**
 * Scalar reward per rating. The graded rating becomes a number the loop can rank/threshold on, and
 * is stored on the feedback row for analytics. Domain constant — one source of truth shared by the
 * backend (scoring, recall ordering) and the clients (display), never a magic number in code.
 */
export const RATING_REWARD: Readonly<Record<Rating, number>> = {
  poor: -2,
  average: -1,
  good: 1,
  excellent: 2,
  outstanding: 3,
};

/**
 * The ratings positive enough that the work itself is worth remembering as an exemplar ("what good
 * looks like"). Lower ratings only contribute memory when the user leaves free-text guidance.
 */
export const POSITIVE_RATINGS: ReadonlyArray<Rating> = ['good', 'excellent', 'outstanding'];

/** A user's recorded feedback on one insight. `rewardScore` is the derived scalar from RATING_REWARD. */
export interface InsightFeedback {
  readonly id: UUID;
  readonly insightId: UUID;
  readonly rating: Rating;
  readonly rewardScore: number;
  /** The free-text "any other text" the user left, or null. */
  readonly comment: string | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
