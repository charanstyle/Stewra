/**
 * Durable, per-user settings the user controls. Kept deliberately small — only fields the user can
 * actually change. The control plane resolves these server-side; the agent never sees them.
 */
export interface UserPreferences {
  /**
   * How many days back Gmail is pulled when producing insights. Bounded by
   * GMAIL_LOOKBACK_MIN_DAYS..GMAIL_LOOKBACK_MAX_DAYS. Always resolved to a concrete number for the
   * client — when the user hasn't chosen one, this is the backend's configured default.
   */
  readonly gmailLookbackDays: number;
  /**
   * Whether Stewra may learn the user's writing style from their OWN Sent mail (the experiential
   * style observer). A NEW data use, so it defaults to `false` and only the user can turn it on. When
   * off, no Sent mail is read and no `observed` style rules are proposed.
   */
  readonly learnFromSentMail: boolean;
}
