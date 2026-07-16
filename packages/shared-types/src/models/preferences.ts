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
  /**
   * Whether the user shares read receipts in human chats. When off, opening a conversation still
   * advances their own unread watermark but no per-message read receipt is written or broadcast to the
   * sender — and, symmetrically, the user does not see others' read receipts either. Defaults to `true`.
   */
  readonly readReceiptsEnabled: boolean;
  /**
   * Whether Stewra may send email in response to a request made over WhatsApp — the approve-to-send
   * opt-in. Defaults to `false` and only the user can turn it on, from a signed-in app and with their
   * password, because a WhatsApp identity is a weaker factor than a login and email is irreversible.
   * Even when on, WhatsApp never triggers a send directly: Stewra drafts the mail and the user approves
   * it on their strong-identity device. Written ONLY through the password-gated channel endpoint, never
   * the generic preferences update.
   */
  readonly sendEmailOverWhatsapp: boolean;
}
