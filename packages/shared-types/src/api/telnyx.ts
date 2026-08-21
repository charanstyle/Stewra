/**
 * Inbound SMS received through the install's Telnyx messaging profile.
 *
 * A platform-operator surface, not a product one: it exists so end-to-end tests can read the
 * verification codes other services text to the install's own test numbers (WhatsApp registration,
 * 2FA), through the API rather than by guessing at a provider portal. Nothing here is org-scoped.
 */
export interface InboundSms {
  /** The sender, E.164. */
  readonly from: string;
  /** The install's number that received it, E.164. */
  readonly to: string;
  readonly text: string;
  /** When Telnyx received it (ISO-8601). */
  readonly receivedAt: string;
  /** Telnyx's message id — the dedupe key. */
  readonly providerMessageId: string;
}

export interface ListInboundSmsResponse {
  /** Newest last. Only what arrived within the retention window (one hour). */
  readonly messages: readonly InboundSms[];
}
