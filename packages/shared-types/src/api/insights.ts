import type { AgentInsight, ResourceKind } from '../broker/contract';

/** Inclusive bounds on the Gmail lookback window (in days). Single source of truth shared by the
 * API request validator (backend) and the UI form (website) — never re-typed as a literal. */
export const GMAIL_LOOKBACK_MIN_DAYS = 1;
export const GMAIL_LOOKBACK_MAX_DAYS = 90;

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
}
