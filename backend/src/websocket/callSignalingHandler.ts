import * as Sentry from '@sentry/node';
import { z } from 'zod';
import { CLIENT_EVENTS, SERVER_EVENTS } from '@stewra/shared-types';
import type {
  CallAnsweredEvent,
  CallDeclinedEvent,
  CallEndReason,
  CallEndedEvent,
  CallErrorEvent,
  CallIncomingEvent,
  CallRemoteAnswerEvent,
  CallRemoteIceEvent,
  CallRemoteOfferEvent,
  CallStatus,
  ChatMessageEvent,
} from '@stewra/shared-types';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { callService } from '../services/callService.js';
import { BaseSocketHandler } from './baseSocketHandler.js';
import { conversationRoom, userRoom } from './types.js';

/** How long an unanswered call rings before it auto-ends as a missed call. */
const RING_TIMEOUT_MS = 60_000;

/**
 * Ephemeral, in-memory state for a live call. The backend runs signaling as a single logical registry
 * keyed by callId; media never touches the server. This map is MODULE-level (shared across every
 * per-connection handler instance) because the caller and callee are on different sockets and must see
 * the same call. If the backend is ever horizontally scaled this must move to Redis — the same caveat
 * that already applies to Socket.IO rooms.
 */
interface ActiveCall {
  readonly callId: string;
  readonly conversationId: string;
  readonly callerId: string;
  readonly calleeId: string;
  answered: boolean;
  answeredAt: number | null;
  ringTimeout: NodeJS.Timeout | null;
}

const activeCalls = new Map<string, ActiveCall>();

// ── inbound payload schemas (mirror realtime/payloads.ts; every socket payload is untrusted) ──────────
const descriptionSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1),
});
const iceCandidateSchema = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable(),
  sdpMLineIndex: z.number().int().nullable(),
});
const InitiateSchema = z.object({
  conversationId: z.string().uuid(),
  callType: z.enum(['audio', 'video']),
});
const LifecycleSchema = z.object({ callId: z.string().uuid() });
const SignalSchema = z.object({ callId: z.string().uuid(), description: descriptionSchema });
const IceSchema = z.object({ callId: z.string().uuid(), candidate: iceCandidateSchema });

type Ack = ((response: unknown) => void) | undefined;

/**
 * WebRTC signaling relay for 1:1 audio/video calls. The backend relays signaling (SDP offer/answer, ICE)
 * and tracks call lifecycle — it never carries media. Authorization is delegated to `callService`
 * (active participant + contact, never the Stewra-AI thread). A `call_sessions` row is opened on
 * initiate and closed exactly once on the first of end/decline/timeout/disconnect, which also writes the
 * inline `call_start`/`call_end` markers that render calls in the conversation.
 */
export class CallSignalingHandler extends BaseSocketHandler {
  register(): void {
    this.on(CLIENT_EVENTS.CALL_INITIATE, InitiateSchema, (p, ack) => this.handleInitiate(p, ack));
    this.on(CLIENT_EVENTS.CALL_ANSWER, LifecycleSchema, (p, ack) => this.handleAnswer(p, ack));
    this.on(CLIENT_EVENTS.CALL_DECLINE, LifecycleSchema, (p, ack) => this.handleDecline(p, ack));
    this.on(CLIENT_EVENTS.CALL_END, LifecycleSchema, (p, ack) => this.handleEnd(p, ack));
    this.on(CLIENT_EVENTS.CALL_OFFER, SignalSchema, (p, ack) => this.handleOffer(p, ack));
    this.on(CLIENT_EVENTS.CALL_ANSWER_SDP, SignalSchema, (p, ack) => this.handleAnswerSdp(p, ack));
    this.on(CLIENT_EVENTS.CALL_ICE_CANDIDATE, IceSchema, (p, ack) => this.handleIce(p, ack));

    // On disconnect, tear down any call this user is in (the other party sees it as failed).
    this.onCleanup(() => this.cleanupCalls());
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────────────

  private async handleInitiate(
    payload: z.infer<typeof InitiateSchema>,
    ack: Ack,
  ): Promise<void> {
    let calleeId: string;
    try {
      calleeId = await callService.resolveDirectCallee(this.userId, payload.conversationId);
    } catch (error) {
      if (error instanceof AppError) {
        this.emitError(this.userId, null, error.message);
        this.reply(ack, { ok: false, error: error.message });
        return;
      }
      throw error;
    }

    // Reject a second concurrent call in the same conversation (double-dial / glare).
    for (const existing of activeCalls.values()) {
      if (existing.conversationId === payload.conversationId) {
        this.reply(ack, { ok: false, error: 'busy' });
        return;
      }
    }

    const session = await callService.open(
      this.userId,
      payload.conversationId,
      payload.callType,
      calleeId,
    );

    const ringTimeout = setTimeout(() => {
      void this.finalizeCall(session.id, 'missed', 'timeout', [this.userId, calleeId]).catch(
        (error: unknown) => Sentry.captureException(error),
      );
    }, RING_TIMEOUT_MS);

    activeCalls.set(session.id, {
      callId: session.id,
      conversationId: payload.conversationId,
      callerId: this.userId,
      calleeId,
      answered: false,
      answeredAt: null,
      ringTimeout,
    });

    const incoming: CallIncomingEvent = {
      callId: session.id,
      conversationId: payload.conversationId,
      fromUserId: this.userId,
      callType: payload.callType,
    };
    this.io.to(userRoom(calleeId)).emit(SERVER_EVENTS.CALL_INCOMING, incoming);
    // Also ring the callee's Android devices via FCM so a locked / backgrounded / killed phone rings
    // full-screen (the socket emit above only reaches a live app). Fire-and-forget; deduped natively.
    void callService.sendIncomingCallPush(session, calleeId).catch((error: unknown) =>
      Sentry.captureException(error),
    );
    logger.info('call initiated', { callId: session.id, callerId: this.userId, calleeId });
    this.reply(ack, { ok: true, call: session });
  }

  private async handleAnswer(payload: z.infer<typeof LifecycleSchema>, ack: Ack): Promise<void> {
    const call = activeCalls.get(payload.callId);
    if (call === undefined || this.userId !== call.calleeId || call.answered) {
      this.reply(ack, { ok: false, error: 'invalid_call' });
      return;
    }
    call.answered = true;
    call.answeredAt = Date.now();
    this.clearRing(call);

    const result = await callService.markAccepted(call.callId);
    const event: CallAnsweredEvent = { callId: call.callId, byUserId: call.calleeId };
    this.io.to(userRoom(call.callerId)).emit(SERVER_EVENTS.CALL_ANSWERED, event);
    if (result !== null) this.emitConversationMessage(call.conversationId, result.message);
    logger.info('call answered', { callId: call.callId });
    this.reply(ack, { ok: true });
  }

  private async handleDecline(payload: z.infer<typeof LifecycleSchema>, ack: Ack): Promise<void> {
    const call = activeCalls.get(payload.callId);
    if (call === undefined || this.userId !== call.calleeId) {
      this.reply(ack, { ok: false, error: 'invalid_call' });
      return;
    }
    activeCalls.delete(call.callId);
    this.clearRing(call);

    const result = await callService.close(call.callId, 'declined', 'declined', null);
    const event: CallDeclinedEvent = { callId: call.callId, byUserId: call.calleeId };
    this.io.to(userRoom(call.callerId)).emit(SERVER_EVENTS.CALL_DECLINED, event);
    if (result !== null) this.emitConversationMessage(call.conversationId, result.message);
    logger.info('call declined', { callId: call.callId });
    this.reply(ack, { ok: true });
  }

  private async handleEnd(payload: z.infer<typeof LifecycleSchema>, ack: Ack): Promise<void> {
    const call = activeCalls.get(payload.callId);
    if (call === undefined || !this.isParticipant(call)) {
      this.reply(ack, { ok: false, error: 'invalid_call' });
      return;
    }
    // Answered → a normal hangup; ended before answer → the caller cancelled (a missed call).
    const status: CallStatus = call.answered ? 'ended' : 'missed';
    const reason: CallEndReason = call.answered ? 'hangup' : 'cancelled';
    await this.finalizeCall(call.callId, status, reason, [this.otherParty(call)]);
    this.reply(ack, { ok: true });
  }

  // ── signaling relay (offer / answer / ICE forwarded verbatim to the other party) ─────────────────────

  private handleOffer(payload: z.infer<typeof SignalSchema>, ack: Ack): void {
    const call = activeCalls.get(payload.callId);
    if (call === undefined || !this.isParticipant(call)) {
      this.reply(ack, { ok: false, error: 'invalid_call' });
      return;
    }
    const event: CallRemoteOfferEvent = {
      callId: call.callId,
      fromUserId: this.userId,
      description: payload.description,
    };
    this.io.to(userRoom(this.otherParty(call))).emit(SERVER_EVENTS.CALL_REMOTE_OFFER, event);
    this.reply(ack, { ok: true });
  }

  private handleAnswerSdp(payload: z.infer<typeof SignalSchema>, ack: Ack): void {
    const call = activeCalls.get(payload.callId);
    if (call === undefined || !this.isParticipant(call)) {
      this.reply(ack, { ok: false, error: 'invalid_call' });
      return;
    }
    const event: CallRemoteAnswerEvent = {
      callId: call.callId,
      fromUserId: this.userId,
      description: payload.description,
    };
    this.io.to(userRoom(this.otherParty(call))).emit(SERVER_EVENTS.CALL_REMOTE_ANSWER, event);
    this.reply(ack, { ok: true });
  }

  private handleIce(payload: z.infer<typeof IceSchema>, ack: Ack): void {
    const call = activeCalls.get(payload.callId);
    if (call === undefined || !this.isParticipant(call)) {
      this.reply(ack, { ok: false, error: 'invalid_call' });
      return;
    }
    const event: CallRemoteIceEvent = {
      callId: call.callId,
      fromUserId: this.userId,
      candidate: payload.candidate,
    };
    this.io.to(userRoom(this.otherParty(call))).emit(SERVER_EVENTS.CALL_REMOTE_ICE_CANDIDATE, event);
    this.reply(ack, { ok: true });
  }

  // ── disconnect cleanup ───────────────────────────────────────────────────────────────────────────────

  private async cleanupCalls(): Promise<void> {
    for (const call of activeCalls.values()) {
      if (!this.isParticipant(call)) continue;
      const status: CallStatus = call.answered ? 'ended' : 'missed';
      await this.finalizeCall(call.callId, status, 'failed', [this.otherParty(call)]).catch(
        (error: unknown) => Sentry.captureException(error),
      );
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Close a call once: remove it from the registry (the in-memory guard), clear its ring timer, persist
   * the terminal session + inline `call_end` marker, and notify the given recipients. Concurrent paths
   * (end + timeout + disconnect) converge here; the map delete makes the notify/marker fire exactly once.
   */
  private async finalizeCall(
    callId: string,
    status: CallStatus,
    reason: CallEndReason,
    notifyUserIds: ReadonlyArray<string>,
  ): Promise<void> {
    const call = activeCalls.get(callId);
    if (call === undefined) return;
    activeCalls.delete(callId);
    this.clearRing(call);

    const durationSec =
      call.answeredAt !== null ? Math.max(0, Math.round((Date.now() - call.answeredAt) / 1000)) : null;

    const result = await callService.close(callId, status, reason, durationSec);
    const event: CallEndedEvent = { callId, reason };
    for (const uid of notifyUserIds) {
      this.io.to(userRoom(uid)).emit(SERVER_EVENTS.CALL_ENDED, event);
    }
    if (result !== null) this.emitConversationMessage(call.conversationId, result.message);
    logger.info('call ended', { callId, reason, durationSec });
  }

  private clearRing(call: ActiveCall): void {
    if (call.ringTimeout !== null) {
      clearTimeout(call.ringTimeout);
      call.ringTimeout = null;
    }
  }

  private isParticipant(call: ActiveCall): boolean {
    return this.userId === call.callerId || this.userId === call.calleeId;
  }

  private otherParty(call: ActiveCall): string {
    return this.userId === call.callerId ? call.calleeId : call.callerId;
  }

  private emitError(userId: string, callId: string | null, message: string): void {
    const event: CallErrorEvent = { callId, message };
    this.io.to(userRoom(userId)).emit(SERVER_EVENTS.CALL_ERROR, event);
  }

  /** Fan the inline call marker out to the conversation room so it renders in the chat live. */
  private emitConversationMessage(conversationId: string, message: ChatMessageEvent['message']): void {
    const event: ChatMessageEvent = { message };
    this.io.to(conversationRoom(conversationId)).emit(SERVER_EVENTS.CHAT_MESSAGE, event);
  }

  private reply(ack: Ack, response: unknown): void {
    if (typeof ack === 'function') ack(response);
  }
}
