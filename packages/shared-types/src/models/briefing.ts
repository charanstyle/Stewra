import type { ISODateString, UUID } from '../common/base';

/**
 * A Briefing — the natural-language "here's your day" summary Stewra computes proactively and shows
 * at the top of the Today page. Derived from the user's synced mail + calendar; it is advice/summary
 * only. One current briefing per user; recomputed by the background job.
 */

/** A titled block of the briefing (e.g. "Inbox", "Calendar", "Waiting on you"). */
export interface BriefingSection {
  readonly heading: string;
  readonly body: string;
}

export interface Briefing {
  readonly id: UUID;
  /** The one-paragraph headline summary shown first. */
  readonly summary: string;
  readonly sections: ReadonlyArray<BriefingSection>;
  readonly generatedAt: ISODateString;
}
