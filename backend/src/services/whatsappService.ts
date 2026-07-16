import * as Sentry from '@sentry/node';
import type { ChannelIdentity, ChannelLinkChallenge } from '@stewra/shared-types';
import { channelIdentityRepository } from '../repositories/channelIdentityRepository';
import { channelSender, WHATSAPP_CHANNEL } from './channelSenders';
import { preferencesService } from './preferencesService';
import { renderWhatsappEmailReply } from './whatsappEmailNotice';
import { stewraTurnService, STEWRA_FAILURE_TEXT } from './stewraTurnService';
import { auditWriter } from '../control-plane/audit/auditWriter';
import { config } from '../config/unifiedConfig';
import { logger } from '../utils/logger';

/** A link code as it appears in a message body. Case-insensitive; users retype these by hand. */
const LINK_CODE_PATTERN = /STEWRA-[A-Z0-9]{6}/i;

/**
 * What an UNLINKED number is told. This is the only thing Stewra will ever say to a stranger: it never
 * reaches the agent, never creates a conversation, and never leaks whether the number is known to us.
 */
export const NOT_LINKED_TEXT =
  'To use Stewra on WhatsApp, open the Stewra app → Settings → WhatsApp and link this number.';

export const LINK_SUCCESS_TEXT =
  "You're linked. This chat is now the same conversation you see in the Stewra app — ask me anything.";

export const LINK_FAILED_TEXT =
  "That link code isn't valid or has expired. Generate a fresh one in the Stewra app → Settings → WhatsApp.";

/** Stewra only reads text on WhatsApp today; media would be silently ignored otherwise. */
export const UNSUPPORTED_TEXT =
  'I can only read text messages on WhatsApp right now. Try typing it, or use the Stewra app for voice.';

/**
 * A single inbound WhatsApp message, already narrowed from Meta's batched webhook envelope.
 * `from` is Meta's `wa_id` — an E.164 number with no '+'.
 */
export interface InboundWhatsappMessage {
  readonly id: string;
  readonly from: string;
  readonly text: string | null;
}

/**
 * The WhatsApp channel: linking, and turning an inbound message into a Stewra turn.
 *
 * SECURITY MODEL. Meta's webhook signature proves a request came from *Meta* — it says nothing about
 * WHO sent the message. A phone number is not an authenticated identity, so this service will not act
 * for a number until that number has been bound to a user by the two-factor link flow below (possession
 * of the logged-in session, which mints the code, AND possession of the phone, which sends it).
 * Unknown numbers are answered with one canned line and never reach the agent. Fail closed.
 */
class WhatsappService {
  /**
   * Mint a link challenge for an authenticated user: a single-use code plus a wa.me deep link that
   * opens WhatsApp with the code pre-filled, so linking is one tap and there's nothing to mistype.
   */
  async createLinkChallenge(userId: string): Promise<ChannelLinkChallenge> {
    const { code, expiresAt } = await channelIdentityRepository.createLinkCode(
      WHATSAPP_CHANNEL,
      userId,
      config.whatsapp.linkCodeTtlMs,
    );
    return {
      channel: WHATSAPP_CHANNEL,
      code,
      deepLink: `https://wa.me/${config.whatsapp.businessNumber}?text=${encodeURIComponent(code)}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** The user's current WhatsApp link, if any. */
  async getIdentity(userId: string): Promise<ChannelIdentity | null> {
    return channelIdentityRepository.findByUser(WHATSAPP_CHANNEL, userId);
  }

  /** Revoke the link. The user can always cut the channel off (principle 7: revocable). */
  async unlink(userId: string): Promise<boolean> {
    const removed = await channelIdentityRepository.unlink(WHATSAPP_CHANNEL, userId);
    if (removed) {
      await auditWriter.write({
        userId,
        action: 'disconnect',
        resourceType: 'channel',
        resourceId: WHATSAPP_CHANNEL,
        summary: 'Unlinked WhatsApp',
        success: true,
        metadata: { channel: WHATSAPP_CHANNEL },
      });
    }
    return removed;
  }

  /**
   * Handle one inbound message end-to-end. Called OFF the webhook's request path — the webhook has
   * already 200'd, because Meta retries for up to 7 days on a slow or failed ACK and a retry would
   * replay the turn.
   *
   * Never throws: a rejection here has nowhere to go. Failures are captured to Sentry and, where we can,
   * surfaced to the user on-channel rather than leaving them staring at silence.
   */
  async handleInbound(message: InboundWhatsappMessage): Promise<void> {
    try {
      // Meta guarantees redelivery, so claim the id first. Losing this race means a duplicate — drop it
      // rather than answer (and bill for) the same message twice.
      const claimed = await channelIdentityRepository.claimInboundMessage(
        WHATSAPP_CHANNEL,
        message.id,
      );
      if (!claimed) {
        logger.info('whatsapp: duplicate delivery ignored', { providerMessageId: message.id });
        return;
      }

      if (message.text === null) {
        await this.reply(message.from, UNSUPPORTED_TEXT);
        return;
      }

      // A link code is the ONE thing we accept from an unrecognised number.
      const codeMatch = LINK_CODE_PATTERN.exec(message.text);
      if (codeMatch) {
        await this.redeemLink(message.from, codeMatch[0].toUpperCase());
        return;
      }

      const userId = await channelIdentityRepository.findUserIdByAddress(
        WHATSAPP_CHANNEL,
        message.from,
      );
      if (userId === null) {
        // Unknown number: one canned line, no conversation, no agent call, no user enumeration.
        await this.reply(message.from, NOT_LINKED_TEXT);
        return;
      }

      await this.converse(userId, message);
    } catch (error) {
      Sentry.captureException(error);
      logger.error('whatsapp inbound handling failed', {
        providerMessageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Bind a number to the account that minted the code, then confirm on-channel. */
  private async redeemLink(from: string, code: string): Promise<void> {
    const userId = await channelIdentityRepository.consumeCodeAndLink(WHATSAPP_CHANNEL, code, from);
    if (userId === null) {
      await this.reply(from, LINK_FAILED_TEXT);
      return;
    }
    await auditWriter.write({
      userId,
      action: 'connect',
      resourceType: 'channel',
      resourceId: WHATSAPP_CHANNEL,
      summary: 'Linked WhatsApp',
      success: true,
      metadata: { channel: WHATSAPP_CHANNEL },
    });
    await this.reply(from, LINK_SUCCESS_TEXT);
  }

  /**
   * Run the turn through the shared, channel-agnostic pipeline and carry the reply back to WhatsApp.
   * The same turn also fans out over the socket, so it appears live in the user's web/mobile app.
   */
  private async converse(userId: string, message: InboundWhatsappMessage): Promise<void> {
    const sender = channelSender(WHATSAPP_CHANNEL);
    const text = message.text ?? '';

    // A converse can take seconds. Show read + typing so the user doesn't think it's broken.
    await sender?.indicateTyping?.(message.from, message.id);

    try {
      const reply = await stewraTurnService.handleUserTurn(userId, text);
      // Only ask the opt-in when there's actually a draft to gate — no extra read on the common path.
      const approveToSend =
        reply.proposedEmail !== null
          ? await preferencesService.sendEmailOverWhatsapp(userId)
          : false;
      await this.reply(
        message.from,
        this.renderReply(reply.content, reply.proposedEmail !== null, approveToSend),
      );
    } catch {
      // stewraTurnService already captured to Sentry and emitted stewra:error to the app; the WhatsApp
      // user is on a different transport and would otherwise just get silence.
      await this.reply(message.from, STEWRA_FAILURE_TEXT);
    }
  }

  /**
   * IRREVERSIBLE ACTIONS DO NOT HAPPEN OVER WHATSAPP.
   *
   * A reply may carry a confirm-gated email draft. The send itself NEVER happens on this transport: a
   * phone number is a far weaker factor (SIM-swap, a borrowed handset) than the user's JWT. What the
   * opt-in changes is only the wording:
   *  - default (`approveToSend` false): say the draft exists and send them to the app — the historical
   *    draft-and-defer refusal.
   *  - opt-in on: tell them to approve it in Stewra. Approval still happens on their strong-identity
   *    surface (the app, or a notification they unlock) — this channel only asks.
   * Either way the draft rides on the message as a `pending` proposal; nothing here can send it.
   */
  private renderReply(content: string | null, hasProposal: boolean, approveToSend: boolean): string {
    return renderWhatsappEmailReply(content ?? STEWRA_FAILURE_TEXT, hasProposal, approveToSend);
  }

  /** Best-effort outbound. A send failure is captured, never rethrown into the webhook path. */
  private async reply(to: string, text: string): Promise<void> {
    const sender = channelSender(WHATSAPP_CHANNEL);
    if (sender === null) {
      logger.error('whatsapp: no sender registered', { channel: WHATSAPP_CHANNEL });
      return;
    }
    try {
      await sender.send(to, text);
    } catch (error) {
      Sentry.captureException(error);
      logger.error('whatsapp: reply send failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const whatsappService = new WhatsappService();
