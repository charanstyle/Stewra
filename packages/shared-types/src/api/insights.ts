import type { ISODateString, UUID } from '../common/base';
import type { AgentInsight, ResourceKind } from '../broker/contract';

/** Inclusive bounds on the Gmail lookback window (in days). Single source of truth shared by the
 * API request validator (backend) and the UI form (website) — never re-typed as a literal. */
export const GMAIL_LOOKBACK_MIN_DAYS = 1;
export const GMAIL_LOOKBACK_MAX_DAYS = 90;

/** Inclusive bounds on the Calendar look-AHEAD window (in days). Single source of truth for the
 * backend config validator — the deploy-level default must fall within these. Kept here beside the
 * Gmail bounds so both windows share one contract rather than scattering magic numbers in code. */
export const CALENDAR_LOOKAHEAD_MIN_DAYS = 1;
export const CALENDAR_LOOKAHEAD_MAX_DAYS = 30;

/**
 * Ask the agent to produce one advice-only insight over a connected resource. `purpose` is an
 * optional human-meaningful label recorded in the audit log; the backend supplies a default.
 *
 * How far back Gmail is pulled is NOT a per-request parameter — it's a durable user preference
 * (see UserPreferences.gmailLookbackDays) the control plane resolves server-side, so the window
 * never has to travel through the untrusted agent.
 */
export interface GenerateInsightRequest {
  readonly kind: ResourceKind;
  readonly purpose?: string;
}

export interface GenerateInsightResponse {
  readonly insight: AgentInsight;
  /**
   * The id of the persisted insight, so the client can attach feedback to it
   * (POST /insights/:insightId/feedback). The control plane assigns it when it records the insight.
   */
  readonly insightId: UUID;
}

/**
 * Acknowledgement for the implicit-engagement endpoints (POST /insights/:insightId/seen and
 * /insights/:insightId/dismissed). Both take an empty body — the insight id travels in the path —
 * and return the resulting engagement timestamps so the client can reconcile local state. `seenAt`
 * is set once (first-write-wins impression); `dismissedAt` is set when the user closes the insight
 * without rating it. Either may be null when that event hasn't happened yet.
 */
export interface InsightEngagementResponse {
  readonly insightId: UUID;
  readonly seenAt: ISODateString | null;
  readonly dismissedAt: ISODateString | null;
}
