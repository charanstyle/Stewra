import type { UserPreferences } from '../models/preferences';

/** The user's current preferences (always fully resolved — defaults filled in by the backend). */
export interface GetPreferencesResponse {
  readonly preferences: UserPreferences;
}

/**
 * Update a subset of the user's preferences. Every field is optional; omitted fields are left
 * unchanged. `gmailLookbackDays` must fall within GMAIL_LOOKBACK_MIN_DAYS..GMAIL_LOOKBACK_MAX_DAYS.
 */
export interface UpdatePreferencesRequest {
  readonly gmailLookbackDays?: number;
  /** Turn the Sent-mail style observer on or off (explicit opt-in; defaults off server-side). */
  readonly learnFromSentMail?: boolean;
  /** Share read receipts in human chats (symmetric: off also hides others' receipts). Defaults on. */
  readonly readReceiptsEnabled?: boolean;
}

export interface UpdatePreferencesResponse {
  readonly preferences: UserPreferences;
}
