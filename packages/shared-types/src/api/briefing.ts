import type { Briefing } from '../models/briefing';

/** GET /home/briefing — the user's current briefing, or null if none has been computed yet. */
export interface GetBriefingResponse {
  readonly briefing: Briefing | null;
}
