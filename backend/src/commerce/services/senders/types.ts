import type { CommercePlatform } from '@stewra/shared-types';

/**
 * An outbound port for the COMMERCE plane — an organization messaging a member of the public.
 *
 * Deliberately NOT `services/channelSenders/ChannelSender`. That port carries a Stewra user's own
 * assistant reply and its docblock states, correctly, that it "never sends anything the user didn't
 * ask for by messaging first". This one is business-initiated by design: a client's campaign reaches
 * people who have not written that day, which is the entire point of the product and the exact thing
 * the other port promises never to do. Two products, two ports; collapsing them into one interface is
 * how the assistant's promise eventually gets broken by a change made for the commerce plane.
 *
 * What replaces that promise here is consent, not shape: a business must hold lawful opt-in for every
 * recipient, and outside the 24-hour service window Meta will only deliver an approved template.
 * {@link CommerceSender.sendTemplate} exists so that constraint is visible in the type rather than
 * discovered when a broadcast silently fails to arrive.
 */
export interface CommerceSender {
  readonly platform: CommercePlatform;

  /**
   * A free-form reply. Valid ONLY inside the 24-hour customer-service window the contact opened by
   * messaging first — outside it Meta accepts the call and never delivers the message, which is why
   * the caller must check `serviceWindowExpiresAt` rather than rely on an error.
   *
   * Returns the platform's message id, so the send can be reconciled with the delivery webhook.
   */
  sendText(to: string, body: string): Promise<string>;

  /**
   * An approved template — the only thing that can be delivered outside the service window, and the
   * only business-initiated send Meta permits at all.
   *
   * `templateName` and `languageCode` must match a template Meta has approved for this account;
   * `variables` fill its positional body placeholders in order.
   */
  sendTemplate(params: {
    to: string;
    templateName: string;
    languageCode: string;
    variables?: readonly string[];
  }): Promise<string>;
}

/** A connected account with its credential already resolved out of the vault, ready to send with. */
export interface ResolvedChannelAccount {
  readonly id: string;
  readonly orgId: string;
  readonly platform: CommercePlatform;
  readonly externalAccountId: string;
  /** WhatsApp's `phone_number_id` — the `/{id}/messages` this account posts to. */
  readonly phoneNumberId: string | null;
  /** The plaintext access token. Held only for the duration of a send; never logged, never stored. */
  readonly accessToken: string;
}
