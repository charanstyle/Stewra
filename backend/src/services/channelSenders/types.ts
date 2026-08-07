import type { MessagingChannel } from '@stewra/shared-types';

/**
 * The outbound port for a messaging channel — how Stewra says something back on the transport a turn
 * arrived on. Kept deliberately narrow: a channel carries TEXT out of Stewra, nothing else. It is not
 * an action surface, and it never sends anything the user didn't ask for by messaging first.
 *
 * That last rule is the **personal-assistant plane's** rule, and it is not negotiable here: this port
 * exists to answer one trusting individual, so a message they did not invite is a betrayal of the
 * product. It is deliberately NOT a statement about the whole codebase. `backend/src/commerce/` is a
 * separate bounded context serving businesses messaging their own customers, and it has its own
 * sender port that does permit business-initiated sends — gated on per-contact versioned consent,
 * WhatsApp's approved templates, and a suppression list, none of which apply to this one.
 *
 * Two ports, two products. Do not widen this interface to serve that one; add to the commerce port
 * instead. See `backend/src/commerce/services/senders/types.ts`.
 */
export interface ChannelSender {
  readonly channel: MessagingChannel;
  /** Deliver `text` to a channel address (for WhatsApp, an E.164 number without '+'). */
  send(address: string, text: string): Promise<void>;
  /**
   * Show a typing/'…' indicator, if the channel has one. Best-effort — a failure here must never fail
   * the turn. Worth doing: an LLM reply takes seconds, and silence reads as breakage.
   */
  indicateTyping?(address: string, inboundMessageId: string): Promise<void>;
}
