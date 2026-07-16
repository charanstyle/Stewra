import { GMAIL_PROVIDER, GmailSender } from './gmailSender.js';
import type { EmailSender } from './types.js';

export type { EmailSender, OutboundEmail, SentReceipt } from './types.js';
export { GMAIL_PROVIDER } from './gmailSender.js';

/** Build a sender for a provider from its vaulted credential (e.g. a Gmail refresh token). */
type SenderFactory = (credential: string) => EmailSender;

/**
 * The email-provider registry — the single place new backends plug in. Add an SMTP or Outlook adapter
 * and register it here; the confirm-gated executor picks whichever provider the user has a usable
 * connection for, so the send tool is provider-agnostic by construction (never Gmail-only).
 */
const REGISTRY: ReadonlyMap<string, SenderFactory> = new Map<string, SenderFactory>([
  [GMAIL_PROVIDER, (refreshToken) => new GmailSender(refreshToken)],
]);

/** Provider codes that currently have a send adapter — the executor only picks a connection matching one. */
export function sendableProviders(): ReadonlyArray<string> {
  return [...REGISTRY.keys()];
}

/** Build a sender for `provider` bound to `credential`, or null when no adapter is registered. */
export function buildEmailSender(provider: string, credential: string): EmailSender | null {
  const factory = REGISTRY.get(provider);
  return factory ? factory(credential) : null;
}
