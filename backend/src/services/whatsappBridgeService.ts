import * as Sentry from '@sentry/node';
import type { BridgeAllowedChat, BridgeInboundPayload, BridgeWaState } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { hmacField } from '../control-plane/vault/fieldCrypto.js';
import { bridgeDeviceRepository } from '../repositories/bridgeDeviceRepository.js';
import { channelIdentityRepository } from '../repositories/channelIdentityRepository.js';
import { whatsappStore } from '../repositories/whatsappStore.js';
import { dispatchToBridge } from '../websocket/bridgeEmitter.js';
import { whatsappEmailApprovalService } from './whatsappEmailApprovalService.js';
import { emailApprovalPushService } from './emailApprovalPushService.js';
import { renderWhatsappEmailReply } from './whatsappEmailNotice.js';
import { redis } from './redisClient.js';
import { STEWRA_FAILURE_TEXT, stewraTurnService } from './stewraTurnService.js';
import { logger } from '../utils/logger.js';

const CHANNEL = 'whatsapp_personal' as const;

/** How many times a queued send may be attempted before we stop and mark it visibly failed. */
const MAX_SEND_ATTEMPTS = 3;

/**
 * The experimental companion-device channel's runtime: what happens when the Stewra Bridge on a user's
 * own computer forwards a message, and how an approved reply gets back out.
 *
 * Nothing in this file touches WhatsApp. The bridge holds that connection; we hold none. Every function
 * here is either "record what the user's machine told us" or "hand the user's machine something to do".
 */
class WhatsappBridgeService {
  /** The bridge came online (or changed state). Record it, then hand it anything that was waiting. */
  async onBridgeOnline(userId: string, deviceId: string, waState: BridgeWaState): Promise<void> {
    await bridgeDeviceRepository.markSeen(deviceId, waState);
    // Only a bridge with a live WhatsApp socket can actually deliver anything.
    if (waState === 'open') {
      await this.drainOutbox(userId);
    }
  }

  async onStateChange(deviceId: string, waState: BridgeWaState): Promise<void> {
    await bridgeDeviceRepository.markSeen(deviceId, waState);
  }

  /** The device's authoritative allowlist. Chats it no longer lists are deleted, messages and all. */
  async onAllowedChats(userId: string, chats: readonly BridgeAllowedChat[]): Promise<void> {
    await whatsappStore.replaceAllowedChats(userId, [...chats]);
    logger.info('bridge: allowlist synced', { userId, chats: chats.length });
  }

  /**
   * One inbound message from a chat the DEVICE decided was allowed.
   *
   * Three gates, in this order, and each one matters:
   *
   *  1. DEDUPE. Baileys `key.id` is unique per chat, not globally, so the claim is namespaced by the
   *     chat's HMAC. This is also what breaks the echo loop — see `deliver`.
   *
   *  2. THE SERVER RE-CHECKS THE ALLOWLIST. The device filters first, but "the client promised" is not a
   *     security control. A buggy or tampered bridge must not be able to push us a chat the user never
   *     allowed, so an unknown JID is dropped here regardless of what the payload claims.
   *
   *  3. ONLY THE SELF-CHAT GETS AN ANSWER. Stewra replies exclusively in the user's own "Message
   *     yourself" chat. A message from a third party is stored so Stewra can tell the user about it, and
   *     is NEVER auto-replied to — Stewra must not speak to other people on the user's behalf without
   *     the user approving those words. That is a hard line, not a default.
   */
  async onInbound(userId: string, payload: BridgeInboundPayload): Promise<void> {
    const chat = await whatsappStore.findChatByJid(userId, payload.jid);
    if (chat === null) {
      logger.warn('bridge: dropped a message for a chat the user has not allowed', { userId });
      return;
    }

    // Namespaced by chat, because `key.id` collides across chats.
    const dedupeKey = `${hmacField(payload.jid)}:${payload.providerMessageId}`;
    const claimed = await channelIdentityRepository.claimInboundMessage(CHANNEL, dedupeKey);
    if (!claimed) {
      // Either a genuine redelivery, or WhatsApp echoing back a message WE just sent (see `deliver`).
      logger.debug('bridge: duplicate inbound ignored', { userId });
      return;
    }

    await whatsappStore.recordMessage({
      userId,
      chatId: chat.id,
      providerMessageId: payload.providerMessageId,
      direction: 'inbound',
      fromMe: payload.fromMe,
      text: payload.text,
      sentAt: new Date(payload.sentAt),
    });

    if (!chat.isSelfChat) {
      // Stored, and that is all. Stewra will surface it to the user; it will not answer for them.
      return;
    }

    await this.answerInSelfChat(userId, chat.id, payload.text);
  }

  /**
   * Run the turn through the same channel-agnostic pipeline every other surface uses, then queue the
   * reply back into the user's own WhatsApp. The turn also fans out over the socket, so the same
   * exchange appears live in the web app — the user messaging themself on WhatsApp and watching Stewra
   * answer in the browser is the whole proof that this is one assistant, not two.
   */
  private async answerInSelfChat(userId: string, chatId: string, text: string): Promise<void> {
    let reply: string;
    try {
      const message = await stewraTurnService.handleUserTurn(userId, text);
      const body = message.content ?? STEWRA_FAILURE_TEXT;
      if (message.proposedEmail !== null) {
        // Same draft, different wording depending on the opt-in — and only the wording. With approve-to-
        // send on we invite approval (which happens on a strong-identity surface, never here); off, we
        // keep the historical draft-and-defer refusal. Neither path sends anything from this channel.
        //
        // `isActiveFor`, never the bare preference: it answers for the kill-switch AND the opt-in, so
        // turning the feature off in prod retracts it from users who already opted in — not just from
        // new ones.
        const approveToSend = await whatsappEmailApprovalService.isActiveFor(userId);
        reply = renderWhatsappEmailReply(body, true, approveToSend);
        if (approveToSend) {
          // Push the actionable Approve/Deny prompt to the user's strong-identity device. Fire-and-forget
          // and best-effort: it never sends the email (approval still flows through confirm-email) and a
          // push failure must not derail the WhatsApp reply the user is waiting on.
          void emailApprovalPushService
            .send(userId, { messageId: message.id })
            .catch((err: unknown) =>
              logger.warn('email-approval push failed', { err: String(err), userId }),
            );
        }
      } else {
        reply = body;
      }
    } catch {
      // `stewraTurnService` already captured to Sentry and emitted `stewra:error` to the app. The user is
      // sitting in WhatsApp, though, and would otherwise just get silence.
      reply = STEWRA_FAILURE_TEXT;
    }

    // Queued BEFORE any attempt to deliver it: if no bridge is online, the reply waits rather than
    // evaporating, and the user gets it when they open their laptop.
    const outboxId = await whatsappStore.enqueueSend(userId, chatId, reply);

    const chat = await whatsappStore.findChatById(userId, chatId);
    if (chat === null) {
      logger.warn('bridge: chat vanished between turn and dispatch', { userId, chatId });
      return;
    }
    await this.dispatch(userId, outboxId, chat.jid, reply);
  }

  /**
   * Send an UNSOLICITED line into the user's self-chat — not a reply to a turn, but a proactive relay
   * (e.g. a runner session asking for permission, or reporting it finished) back to the medium the user
   * is watching. Routed through the SAME echo-guarded, budgeted {@link dispatch} path as every reply, so
   * it inherits the loop protection and the send circuit-breaker. No self-chat / no linked WhatsApp is a
   * normal no-op: the caller has no WhatsApp surface for this user. If no bridge is online the line is
   * enqueued and drains on the next connect, exactly like a reply.
   */
  async sendUnsolicitedSelfChat(userId: string, text: string): Promise<void> {
    const chat = await whatsappStore.findSelfChat(userId);
    if (chat === null) return;
    const outboxId = await whatsappStore.enqueueSend(userId, chat.id, text);
    await this.dispatch(userId, outboxId, chat.jid, text);
  }

  /** Hand every still-pending send to whichever bridge is online. Called on `bridge:hello`. */
  async drainOutbox(userId: string): Promise<void> {
    const pending = await whatsappStore.pendingSends(userId);
    if (pending.length === 0) return;

    logger.info('bridge: draining outbox', { userId, pending: pending.length });
    for (const send of pending) {
      await this.dispatch(userId, send.outboxId, send.jid, send.text);
    }
  }

  /**
   * Push one approved send to a bridge, then record what happened.
   *
   * ⚠️ THE ECHO LOOP. In the self-chat, the user's own messages arrive with `fromMe = true` — and so does
   * every message STEWRA sends, because it is sent from the very same WhatsApp account. WhatsApp will
   * therefore echo Stewra's reply straight back to the bridge as a new self-chat message, which would
   * trigger another turn, whose reply would be echoed back again, forever: an infinite loop, running at
   * full LLM cost, sending message after message from the user's real account until WhatsApp bans it.
   *
   * The fix is to CLAIM OUR OWN MESSAGE ID the moment the bridge tells us what it was. The echo then
   * loses the dedupe race in `onInbound` and is dropped, exactly as a redelivery would be. Claiming here
   * rather than filtering in the bridge is deliberate: this must hold even if the bridge is old, buggy,
   * or lying, because the failure mode is a banned account.
   */
  private async dispatch(
    userId: string,
    outboxId: string,
    jid: string,
    text: string,
  ): Promise<void> {
    if (!(await this.withinSendBudget(userId))) {
      // The circuit breaker tripped. Something is wrong — a loop, or a bridge gone haywire — and the
      // right move is to STOP sending from the user's account and be loud about it, not to keep going.
      const error = 'send rate limit exceeded; refusing to send (possible loop)';
      await whatsappStore.markFailed(outboxId, error);
      Sentry.captureException(new Error(`whatsapp-personal: ${error}`));
      logger.error('bridge: send budget exhausted; refusing', { userId, outboxId });
      return;
    }

    const result = await dispatchToBridge(userId, { outboxId, jid, text });
    if (result === null) {
      // No bridge online. Perfectly normal — the laptop is shut. It stays pending and drains on hello.
      logger.info('bridge: no device online; send stays queued', { userId, outboxId });
      return;
    }

    const { deviceId, ack } = result;
    if (!ack.ok || ack.providerMessageId === undefined) {
      await whatsappStore.markAttemptFailed(outboxId, ack.error ?? 'unknown', MAX_SEND_ATTEMPTS);
      logger.warn('bridge: send failed', { userId, outboxId, error: ack.error });
      return;
    }

    // Claim the id we just created BEFORE recording anything else, so the echo cannot win the race.
    await channelIdentityRepository.claimInboundMessage(
      CHANNEL,
      `${hmacField(jid)}:${ack.providerMessageId}`,
    );

    await whatsappStore.markSent(outboxId, deviceId, ack.providerMessageId);

    const chat = await whatsappStore.findChatByJid(userId, jid);
    if (chat !== null) {
      await whatsappStore.recordMessage({
        userId,
        chatId: chat.id,
        providerMessageId: ack.providerMessageId,
        direction: 'outbound',
        fromMe: true,
        text,
        sentAt: new Date(),
      });
    }
  }

  /**
   * The per-user send budget, counted in Redis.
   *
   * Send volume is the single biggest driver of WhatsApp bans, so this is a safety device rather than a
   * throughput tunable — and it is enforced HERE as well as in the bridge, because a limit that only
   * exists on the user's machine is a limit that stops existing the moment that machine misbehaves.
   */
  private async withinSendBudget(userId: string): Promise<boolean> {
    const key = `wa-personal:sends:${userId}`;
    const sends = await redis.incr(key);
    if (sends === 1) {
      await redis.expire(key, 60);
    }
    return sends <= config.whatsappPersonal.maxSendsPerMinute;
  }
}

export const whatsappBridgeService = new WhatsappBridgeService();
