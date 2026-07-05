import type {
  CallEndReason,
  CallKind,
  CallSession,
  CallStatus,
  Message,
  RegisterCallPushTokenRequest,
} from '@stewra/shared-types';
import { callSessionRepository } from '../repositories/callSessionRepository';
import { callPushTokenRepository } from '../repositories/callPushTokenRepository';
import { messageRepository, MessageRepository } from '../repositories/messageRepository';
import { conversationService } from './conversationService';
import { contactService } from './contactService';
import { ForbiddenError, ValidationError } from '../utils/errors';

const HISTORY_LIMIT = 100;

/**
 * Control-plane orchestration for calls. The signaling handler owns the ephemeral in-memory call state
 * (peers, ring timers, relay); THIS service owns everything durable: the authorization gate (participant
 * + contact), the `call_sessions` lifecycle rows, the inline `call_start`/`call_end` system messages
 * that make calls render in the conversation, call history, and ring-token registration. The backend
 * never touches call MEDIA — only this record of it.
 */
class CallService {
  /**
   * Resolve the single callee for a 1:1 call and enforce the authorization gate. A call may only be
   * placed by an active participant of the conversation, only to a contact (not blocked), and never into
   * the Stewra-AI thread. Group calls are not yet supported (rejected until the mesh fast-follow lands).
   */
  async resolveDirectCallee(callerId: string, conversationId: string): Promise<string> {
    const { conversation } = await conversationService.assertParticipant(callerId, conversationId);
    if (conversation.type === 'stewra_ai') {
      throw new ValidationError('The Stewra assistant cannot be called');
    }
    const others = await conversationService.otherActiveParticipantIds(callerId, conversationId);
    if (others.length !== 1) {
      throw new ValidationError('Calls are limited to one other participant for now');
    }
    const callee = others[0];
    if (callee === undefined || !(await contactService.canContact(callerId, callee))) {
      throw new ForbiddenError('You can only call a contact');
    }
    return callee;
  }

  /** Open a ringing call session between the caller and the resolved callee. */
  async open(
    callerId: string,
    conversationId: string,
    callType: CallKind,
    calleeId: string,
  ): Promise<CallSession> {
    return callSessionRepository.open({
      conversationId,
      initiatedBy: callerId,
      callType,
      participantUserIds: [callerId, calleeId],
    });
  }

  /**
   * Mark a call accepted and write the inline `call_start` marker. Returns the updated session and the
   * system message (so the handler can fan it out to the conversation room), or null if the call was no
   * longer ringing (already declined/ended/answered — a lost race).
   */
  async markAccepted(callId: string): Promise<{ session: CallSession; message: Message } | null> {
    const session = await callSessionRepository.markAccepted(callId);
    if (session === undefined) return null;
    const message = await this.writeSystemMarker(session, 'call_start');
    return { session, message };
  }

  /**
   * Close a call to a terminal status (idempotent) and write the inline `call_end` marker. Returns the
   * session + the marker message when THIS call actually closed the session; returns null when the
   * session was already terminal (so the marker is written exactly once across the end/timeout/disconnect
   * paths).
   */
  async close(
    callId: string,
    status: CallStatus,
    endReason: CallEndReason,
    durationSec: number | null,
  ): Promise<{ session: CallSession; message: Message } | null> {
    const before = await callSessionRepository.findById(callId);
    if (before === undefined || this.isTerminal(before.status)) return null;
    const session = await callSessionRepository.close(callId, status, endReason, durationSec);
    if (session === undefined) return null;
    const message = await this.writeSystemMarker(session, 'call_end', durationSec);
    return { session, message };
  }

  /** The caller's recent calls (newest-first) for the call-history screen. */
  async history(userId: string): Promise<CallSession[]> {
    return callSessionRepository.listForUser(userId, HISTORY_LIMIT);
  }

  /** Register (or refresh) this device's background-ring token. */
  async registerPushToken(userId: string, req: RegisterCallPushTokenRequest): Promise<void> {
    await callPushTokenRepository.upsert({
      userId,
      platform: req.platform,
      voipToken: req.voipToken ?? null,
      fcmToken: req.fcmToken ?? null,
    });
  }

  private isTerminal(status: CallStatus): boolean {
    return status === 'declined' || status === 'ended' || status === 'failed' || status === 'missed';
  }

  /**
   * Persist a `call_start`/`call_end` system message attributed to the call's initiator. The call kind
   * (`audio`/`video`) rides on `mediaType` and the answered duration on `mediaDurationSec` so every render
   * site can say "Voice call ended (67s)" vs "Video call ended" without a separate call-type column.
   */
  private async writeSystemMarker(
    session: CallSession,
    type: 'call_start' | 'call_end',
    durationSec: number | null = null,
  ): Promise<Message> {
    return messageRepository.create({
      conversationId: session.conversationId,
      senderId: session.initiatedBy,
      senderKind: MessageRepository.SENDER_USER,
      type,
      content: null,
      mediaType: session.callType,
      mediaDurationSec: durationSec,
    });
  }
}

export const callService = new CallService();
