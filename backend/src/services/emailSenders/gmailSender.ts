import { sendGmailMessage } from '../googleOAuthService.js';
import type { EmailSender, OutboundEmail, SentReceipt } from './types.js';

/** Stable provider code for a Google/Gmail-backed send (matches the connection's `provider` column). */
export const GMAIL_PROVIDER = 'google';

/**
 * Gmail adapter for the {@link EmailSender} port: sends AS the connected user through the Gmail API
 * using their vaulted refresh token (which is why the mail leaves from the user's real address rather
 * than a system mailbox). Bound to one grant's refresh token at construction; the executor builds one
 * per send after picking the connection that carries the `gmail.send` scope.
 */
export class GmailSender implements EmailSender {
  readonly provider = GMAIL_PROVIDER;
  private readonly refreshToken: string;

  constructor(refreshToken: string) {
    this.refreshToken = refreshToken;
  }

  async send(email: OutboundEmail): Promise<SentReceipt> {
    const from = email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail;
    const providerMessageId = await sendGmailMessage(this.refreshToken, {
      from,
      to: email.to,
      subject: email.subject,
      body: email.body,
    });
    return { provider: this.provider, providerMessageId };
  }
}
