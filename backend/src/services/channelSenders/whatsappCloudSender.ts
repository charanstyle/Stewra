import type { MessagingChannel } from '@stewra/shared-types';
import type { ChannelSender } from './types.js';
import { config } from '../../config/unifiedConfig.js';
import { logger } from '../../utils/logger.js';

export const WHATSAPP_CHANNEL: MessagingChannel = 'whatsapp';

/** Meta's hard cap on a text message body. A longer reply is rejected outright, so we split. */
const MAX_BODY_CHARS = 4096;

/** A free-form text reply — valid only inside the 24h customer-service window, which is all we use. */
interface WhatsappTextPayload {
  readonly messaging_product: 'whatsapp';
  readonly recipient_type: 'individual';
  readonly to: string;
  readonly type: 'text';
  readonly text: { readonly preview_url: boolean; readonly body: string };
}

/** Marks the user's message read and raises the typing indicator, in one call. */
interface WhatsappReadPayload {
  readonly messaging_product: 'whatsapp';
  readonly status: 'read';
  readonly message_id: string;
  readonly typing_indicator: { readonly type: 'text' };
}

type WhatsappOutboundPayload = WhatsappTextPayload | WhatsappReadPayload;

/**
 * Split a reply into WhatsApp-sized parts, preferring to break at a paragraph, then a line, then a
 * space — so a split lands between thoughts rather than mid-word. Only a single unbroken >4096-char
 * run gets a hard cut.
 */
export function splitForWhatsapp(text: string, limit: number = MAX_BODY_CHARS): string[] {
  const parts: string[] = [];
  let rest = text.trim();

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer the last paragraph break, else the last newline, else the last space.
    const breakAt = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    );
    // No natural break within the limit (a giant URL or token) — cut hard rather than drop it.
    const cut = breakAt > 0 ? breakAt : limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * Outbound over Meta's OFFICIAL WhatsApp Cloud API.
 *
 * Stewra is always REPLYING to a message the user just sent, so every send here lands inside the
 * 24-hour customer-service window and needs no template. (Note: Meta begins charging for service
 * messages on 2026-10-01 — these replies become a metered per-message cost, with no volume tiers.)
 *
 * Never used to initiate a conversation: Stewra speaks on WhatsApp only when spoken to.
 */
class WhatsappCloudSender implements ChannelSender {
  readonly channel = WHATSAPP_CHANNEL;

  private get endpoint(): string {
    const { graphBaseUrl, graphVersion, phoneNumberId } = config.whatsapp;
    return `${graphBaseUrl}/${graphVersion}/${phoneNumberId}/messages`;
  }

  private async post(payload: WhatsappOutboundPayload): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Meta returns a structured error body; surface it, because "why didn't my reply send" is
      // otherwise invisible — there's no failure on our side, the message simply never appears.
      const detail = await response.text().catch(() => '<unreadable body>');
      throw new Error(`WhatsApp send failed (${response.status}): ${detail}`);
    }
  }

  /** Deliver `text`, split across as many messages as Meta's 4096-char cap requires, in order. */
  async send(address: string, text: string): Promise<void> {
    const parts = splitForWhatsapp(text);
    // Sequential, not Promise.all: WhatsApp renders messages in arrival order, and parallel sends would
    // let part 2 overtake part 1 and scramble the reply.
    for (const part of parts) {
      await this.post({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: address,
        type: 'text',
        text: { preview_url: false, body: part },
      });
    }
  }

  /**
   * Mark the user's message read and show the typing indicator. Best-effort: a failure is logged and
   * swallowed, because it must never cost the user their actual reply.
   */
  async indicateTyping(_address: string, inboundMessageId: string): Promise<void> {
    try {
      await this.post({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: inboundMessageId,
        typing_indicator: { type: 'text' },
      });
    } catch (error) {
      logger.warn('whatsapp typing indicator failed; continuing', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const whatsappCloudSender = new WhatsappCloudSender();
