import type { MessagingChannel } from '@stewra/shared-types';

/**
 * The outbound port for a messaging channel — how Stewra says something back on the transport a turn
 * arrived on. Kept deliberately narrow: a channel carries TEXT out of Stewra, nothing else. It is not
 * an action surface, and it never sends anything the user didn't ask for by messaging first.
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
