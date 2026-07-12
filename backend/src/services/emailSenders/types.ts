/**
 * The provider-agnostic outbound-email port. Stewra's confirm-gated send executor depends ONLY on this
 * interface, never on Gmail directly — so adding another backend (SMTP via the existing nodemailer
 * transport, Microsoft Graph / Outlook, etc.) is a matter of writing one more adapter and registering
 * it in `./index.ts`. Nothing in the agent, the proposal flow, the confirm route, or the client changes.
 */

/** A resolved outbound message: who it is from (the connected account), and the recipient/subject/body. */
export interface OutboundEmail {
  readonly fromEmail: string;
  readonly fromName?: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** Proof of delivery from a provider: which backend sent it, and that backend's message id. */
export interface SentReceipt {
  readonly provider: string;
  readonly providerMessageId: string;
}

/** One delivery backend. `provider` is the stable code stored on the proposal (e.g. `google`). */
export interface EmailSender {
  readonly provider: string;
  send(email: OutboundEmail): Promise<SentReceipt>;
}
