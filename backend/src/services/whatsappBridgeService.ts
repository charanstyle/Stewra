import * as Sentry from '@sentry/node';
import type {
  BridgeAllowedChat,
  BridgeInboundPayload,
  BridgeSendPayload,
  BridgeWaState,
  Message,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { hmacField } from '../control-plane/vault/fieldCrypto.js';
import { bridgeDeviceRepository } from '../repositories/bridgeDeviceRepository.js';
import { channelIdentityRepository } from '../repositories/channelIdentityRepository.js';
import { whatsappStore } from '../repositories/whatsappStore.js';
import type { PendingSend } from '../repositories/whatsappStore.js';
import { BRIDGE_TOO_OLD_FOR_REPLY, BRIDGE_TOO_OLD_FOR_VOICE, dispatchToBridge } from '../websocket/bridgeEmitter.js';
import { whatsappEmailApprovalService } from './whatsappEmailApprovalService.js';
import { emailApprovalPushService } from './emailApprovalPushService.js';
import { renderWhatsappEmailReply } from './whatsappEmailNotice.js';
import { whatsappVoiceService } from './whatsappVoiceService.js';
import { redis } from './redisClient.js';
import { STEWRA_FAILURE_TEXT, stewraTurnService } from './stewraTurnService.js';
import { logger } from '../utils/logger.js';

const CHANNEL = 'whatsapp_personal' as const;

/** How many times a queued send may be attempted before we stop and mark it visibly failed. */
const MAX_SEND_ATTEMPTS = 3;

/**
 * What the person is told, in text, when they spoke but Stewra cannot speak back. Said out loud rather
 * than silently downgraded: a voice note that never arrives must never look like a voice note that was
 * never owed.
 */
export const VOICE_REPLY_UNAVAILABLE_TEXT = '(Voice replies are unavailable right now, so this one is text only.)';

/** A turn as it arrived from the self-chat: either typed or spoken. */
type SelfChatTurn =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'voice'; readonly buffer: Buffer; readonly mime: string };

/**
 * The experimental companion-device channel's runtime: what happens when the Stewra Bridge on a user's
 * own computer forwards a message, and how an approved reply gets back out.
 *
 * Nothing in this file touches WhatsApp. The bridge holds that connection; we hold none. Every function
 * here is either "record what the user's machine told us" or "hand the user's machine something to do".
 */
class WhatsappBridgeService {
  /** The bridge came online (or changed state). Record it, then hand it anything that was waiting. */
  async onBridgeOnline(
    userId: string,
    deviceId: string,
    waState: BridgeWaState,
    appVersion: string,
  ): Promise<void> {
    await bridgeDeviceRepository.markSeen(deviceId, waState, appVersion);
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

    // A voice note is stored as the fact that one arrived (`is_voice`) with an empty body: a third
    // party's clip is deliberately NOT transcribed (Stewra listens to the user, not to everyone who
    // messages them), and the user's own transcript lives in the Stewra conversation the turn writes to.
    await whatsappStore.recordMessage({
      userId,
      chatId: chat.id,
      providerMessageId: payload.providerMessageId,
      direction: 'inbound',
      fromMe: payload.fromMe,
      text: payload.text ?? '',
      isVoice: payload.audio !== undefined,
      sentAt: new Date(payload.sentAt),
    });

    if (!chat.isSelfChat) {
      // Stored, and that is all. Stewra will surface it to the user; it will not answer for them.
      return;
    }

    if (payload.audio !== undefined) {
      await this.answerInSelfChat(userId, chat.id, payload.providerMessageId, {
        kind: 'voice',
        buffer: Buffer.from(payload.audio.data, 'base64'),
        mime: payload.audio.mime,
      });
      return;
    }
    if (payload.text === undefined) {
      // The handler's schema guarantees exactly one body; reaching here is a wiring fault, not a state.
      throw new Error(`bridge inbound ${payload.providerMessageId} carried neither text nor audio`);
    }
    await this.answerInSelfChat(userId, chat.id, payload.providerMessageId, { kind: 'text', text: payload.text });
  }

  /**
   * Run the turn through the same channel-agnostic pipeline every other surface uses, then queue the
   * reply back into the user's own WhatsApp. The turn also fans out over the socket, so the same
   * exchange appears live in the web app — the user messaging themself on WhatsApp and watching Stewra
   * answer in the browser is the whole proof that this is one assistant, not two.
   *
   * A SPOKEN turn is answered twice, in this order: a voice note (so the person can listen) and then
   * the same words as text (so they can see it in the chat). A typed turn is answered in text only.
   *
   * Every line goes out QUOTING `replyTo` — the message of theirs being answered. In the self-chat
   * Stewra's bubbles and the person's are otherwise identical (same account, same side, same colour),
   * and two voice notes in a row give no clue who said which; the quote is what separates them.
   */
  private async answerInSelfChat(
    userId: string,
    chatId: string,
    replyTo: string,
    turn: SelfChatTurn,
  ): Promise<void> {
    let reply: string;
    let conversationId: string | null = null;
    try {
      let message: Message;
      if (turn.kind === 'voice') {
        const { assistantMessage } = await stewraTurnService.handleVoiceTurn(userId, {
          buffer: turn.buffer,
          mime: turn.mime,
        });
        message = assistantMessage;
      } else {
        message = await stewraTurnService.handleUserTurn(userId, turn.text);
      }
      conversationId = message.conversationId;
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

    const chat = await whatsappStore.findChatById(userId, chatId);
    if (chat === null) {
      logger.warn('bridge: chat vanished between turn and dispatch', { userId, chatId });
      return;
    }
    if (turn.kind === 'voice') {
      await this.sendSpokenAndText(userId, chat.id, chat.jid, conversationId, reply, replyTo);
      return;
    }
    await this.sendText(userId, chat.id, chat.jid, reply, replyTo);
  }

  /**
   * Send an UNSOLICITED line into the user's self-chat — not a reply to a turn, but a proactive relay
   * (e.g. a runner session asking for permission, or reporting it finished) back to the medium the user
   * is watching. Routed through the SAME echo-guarded, budgeted {@link dispatch} path as every reply, so
   * it inherits the loop protection and the send circuit-breaker. No self-chat / no linked WhatsApp is a
   * normal no-op: the caller has no WhatsApp surface for this user. If no bridge is online the line is
   * enqueued and drains on the next connect, exactly like a reply.
   *
   * If the person's LAST word to Stewra in this chat was spoken, the relay is spoken too (and then
   * texted) — they are plausibly listening rather than reading, and a session's permission gate is the
   * one line that must not be missed.
   *
   * The line quotes the person's most recent message, so it reads as Stewra answering them rather than
   * as one more bubble in their own voice. Null only when nothing of theirs is stored yet.
   */
  async sendUnsolicitedSelfChat(userId: string, text: string): Promise<void> {
    const chat = await whatsappStore.findSelfChat(userId);
    if (chat === null) return;
    const replyTo = await whatsappStore.lastInboundProviderMessageId(userId, chat.id);
    if (await whatsappStore.lastInboundWasVoice(userId, chat.id)) {
      await this.sendSpokenAndText(userId, chat.id, chat.jid, null, text, replyTo);
      return;
    }
    await this.sendText(userId, chat.id, chat.jid, text, replyTo);
  }

  /**
   * Queue and deliver one text line. Queued BEFORE any attempt to deliver it: if no bridge is online,
   * the line waits rather than evaporating, and the user gets it when they open their laptop.
   */
  private async sendText(
    userId: string,
    chatId: string,
    jid: string,
    text: string,
    replyTo: string | null,
  ): Promise<void> {
    const outboxId = await whatsappStore.enqueueSend({ userId, chatId, text, audioAssetId: null, replyTo });
    await this.dispatch(userId, { outboxId, jid, text, audioAssetId: null, replyTo });
  }

  /**
   * The spoken reply: a voice note carrying `text`, then `text` itself. Two outbox rows, voice first,
   * so the order survives a drain after the laptop reopens.
   *
   * When Stewra cannot speak on this deploy, or the synthesis fails, the person is TOLD so in the text —
   * the failure is captured, never swallowed into a reply that quietly looks like a typed one.
   */
  private async sendSpokenAndText(
    userId: string,
    chatId: string,
    jid: string,
    conversationId: string | null,
    text: string,
    replyTo: string | null,
  ): Promise<void> {
    if (!whatsappVoiceService.available) {
      logger.warn('bridge: spoken turn on a deploy without voice; replying in text only', { userId });
      await this.sendText(userId, chatId, jid, `${text}\n\n${VOICE_REPLY_UNAVAILABLE_TEXT}`, replyTo);
      return;
    }
    let assetId: string;
    try {
      const asset = await whatsappVoiceService.voiceNoteFor(userId, conversationId, text);
      assetId = asset.id;
    } catch (error) {
      Sentry.captureException(error);
      logger.error('bridge: voice note synthesis failed; replying in text only', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.sendText(userId, chatId, jid, `${text}\n\n${VOICE_REPLY_UNAVAILABLE_TEXT}`, replyTo);
      return;
    }
    const voiceOutboxId = await whatsappStore.enqueueSend({ userId, chatId, text, audioAssetId: assetId, replyTo });
    const textOutboxId = await whatsappStore.enqueueSend({ userId, chatId, text, audioAssetId: null, replyTo });
    await this.dispatch(userId, { outboxId: voiceOutboxId, jid, text, audioAssetId: assetId, replyTo });
    await this.dispatch(userId, { outboxId: textOutboxId, jid, text, audioAssetId: null, replyTo });
  }

  /** Hand every still-pending send to whichever bridge is online. Called on `bridge:hello`. */
  async drainOutbox(userId: string): Promise<void> {
    const pending = await whatsappStore.pendingSends(userId);
    if (pending.length === 0) return;

    logger.info('bridge: draining outbox', { userId, pending: pending.length });
    for (const send of pending) {
      await this.dispatch(userId, send);
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
  private async dispatch(userId: string, send: PendingSend): Promise<void> {
    const { outboxId, jid, text, audioAssetId, replyTo } = send;
    if (!(await this.withinSendBudget(userId))) {
      // The circuit breaker tripped. Something is wrong — a loop, or a bridge gone haywire — and the
      // right move is to STOP sending from the user's account and be loud about it, not to keep going.
      const error = 'send rate limit exceeded; refusing to send (possible loop)';
      await whatsappStore.markFailed(outboxId, error);
      Sentry.captureException(new Error(`whatsapp-personal: ${error}`));
      logger.error('bridge: send budget exhausted; refusing', { userId, outboxId });
      return;
    }

    // The clip is read from disk per attempt, never held in the outbox row: Postgres keeps the pointer,
    // the media store keeps the bytes, and an asset that has gone missing fails loudly right here.
    // Rebuilt field by field, so an absent option stays absent under exactOptionalPropertyTypes.
    const payload: BridgeSendPayload = {
      outboxId,
      jid,
      text,
      ...(audioAssetId === null ? {} : { audio: await whatsappVoiceService.wirePayload(userId, audioAssetId) }),
      ...(replyTo === null ? {} : { replyTo }),
    };

    const result = await dispatchToBridge(userId, payload);
    if (result === null) {
      // No bridge online. Perfectly normal — the laptop is shut. It stays pending and drains on hello.
      logger.info('bridge: no device online; send stays queued', { userId, outboxId });
      return;
    }

    const { deviceId, ack } = result;
    if (ack.error === BRIDGE_TOO_OLD_FOR_VOICE) {
      // Not retried: the same bridge will be just as old on the next attempt, and the text twin of this
      // voice note is delivered on its own row, so the person is not left without the words.
      await whatsappStore.markFailed(outboxId, ack.error);
      logger.warn('bridge: voice note dropped; bridge predates voice', { userId, outboxId, deviceId });
      return;
    }
    if (ack.error === BRIDGE_TOO_OLD_FOR_REPLY) {
      // Same shape: an old bridge would post the line unquoted, which in the self-chat is a bubble in
      // the person's own voice — the one rendering this feature exists to avoid. Failed visibly; the
      // bridge's update notice is the fix, not a retry.
      await whatsappStore.markFailed(outboxId, ack.error);
      logger.warn('bridge: reply dropped; bridge predates quoted replies', { userId, outboxId, deviceId });
      return;
    }
    if (!ack.ok || ack.providerMessageId === undefined) {
      // A bridge that fails without saying why still has two DISTINGUISHABLE shapes, so the stored
      // reason names which one it was. Recording 'unknown' collapsed them into a word that tells
      // whoever reads the outbox row nothing at all.
      const reason =
        ack.error ??
        (ack.ok
          ? 'bridge acked ok but returned no providerMessageId'
          : 'bridge nacked with no error message');
      await whatsappStore.markAttemptFailed(outboxId, reason, MAX_SEND_ATTEMPTS);
      logger.warn('bridge: send failed', { userId, outboxId, error: reason });
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
        isVoice: audioAssetId !== null,
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
