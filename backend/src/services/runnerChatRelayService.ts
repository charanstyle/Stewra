import { SERVER_EVENTS } from '@stewra/shared-types';
import type {
  RunnerPermissionPromptPayload,
  RunnerSessionDonePayload,
  StewraReplyEvent,
} from '@stewra/shared-types';
import { messageRepository } from '../repositories/messageRepository.js';
import { emitToConversation } from '../websocket/emitter.js';
import { whatsappBridgeService } from './whatsappBridgeService.js';
import { logger } from '../utils/logger.js';

/**
 * Which medium a chat-initiated runner session is being watched on, so its later, unsolicited moments
 * (a permission gate, the final result) are relayed back to the SAME place the user asked from — the
 * core "ask on WhatsApp, get answered on WhatsApp" property. `stewra_chat` is the in-app/web Stewra
 * thread (a live socket); `whatsapp` additionally pushes the line into the user's self-chat.
 */
export type RunnerChatChannel = 'stewra_chat' | 'whatsapp';

/** Where a session's relayed lines go, captured when it is started from a conversation. */
interface RunnerOrigin {
  readonly userId: string;
  readonly conversationId: string;
  readonly channel: RunnerChatChannel;
  readonly deviceName: string;
  readonly workspaceName: string;
}

/**
 * The permission gate a chat-watched session is currently blocked on — enough to resolve a
 * natural-language "yes"/"no" reply into a concrete decision without the user ever seeing an id.
 */
export interface PendingRunnerPermission {
  readonly userId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly allowOptionId: string | null;
  readonly denyOptionId: string | null;
  readonly title: string;
}

/**
 * Bridges a runner session's async lifecycle back into the CHAT the user started it from.
 *
 * The socket already streams every `runner-ui:*` event to a Runners screen; this service is the parallel
 * path for the conversational surfaces (WhatsApp, and the Stewra chat thread) that don't hold that
 * screen open. It relays only the moments that need the human — a permission request and the final
 * result — so a button-less channel stays quiet until it actually needs a reply, and it remembers the
 * pending permission so a plain "yes" resolves against it. Purely in-memory: a session is short-lived,
 * and if the process restarts mid-session the app still has the authoritative socket stream; the chat
 * relay simply goes quiet, which is a safe degradation, never a wrong action.
 */
class RunnerChatRelayService {
  private readonly origins = new Map<string, RunnerOrigin>();
  private readonly pending = new Map<string, PendingRunnerPermission>();

  /** Remember where a session's relayed lines should go. Called when a session is started from a chat. */
  registerOrigin(sessionId: string, origin: RunnerOrigin): void {
    this.origins.set(sessionId, origin);
  }

  /** The most recent permission a session of this user is blocked on, or null. */
  latestPendingPermission(userId: string): PendingRunnerPermission | null {
    let latest: PendingRunnerPermission | null = null;
    for (const p of this.pending.values()) {
      if (p.userId === userId) latest = p;
    }
    return latest;
  }

  /** Forget a session's pending permission once it has been decided. */
  clearPermission(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  /**
   * A runner hit a permission gate. Remember it (so a "yes" can resolve) and, if the session is being
   * watched from a chat, relay a natural-language ask to that medium. Best-effort: a relay failure must
   * never stop the socket path that already delivered the prompt to a Runners screen.
   */
  async onPermission(userId: string, payload: RunnerPermissionPromptPayload): Promise<void> {
    const allow = payload.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
    const deny = payload.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
    this.pending.set(payload.sessionId, {
      userId,
      sessionId: payload.sessionId,
      promptId: payload.promptId,
      allowOptionId: allow?.id ?? null,
      denyOptionId: deny?.id ?? null,
      title: payload.title,
    });

    const origin = this.origins.get(payload.sessionId);
    if (origin === undefined) return;
    const detail = payload.detail.trim().length > 0 ? ` (${payload.detail.trim()})` : '';
    const line = `Permission needed on ${origin.workspaceName}: ${payload.title}${detail}. Reply "yes" to allow or "no" to deny.`;
    await this.deliver(origin, line);
  }

  /**
   * A session finished. Relay a short, medium-appropriate summary (and, when there is committed work, a
   * nudge that it can be pushed by just saying so) to the chat it came from, then forget it.
   */
  async onDone(payload: RunnerSessionDonePayload): Promise<void> {
    const origin = this.origins.get(payload.sessionId);
    this.pending.delete(payload.sessionId);
    if (origin === undefined) return;
    this.origins.delete(payload.sessionId);

    let line: string;
    if (payload.status === 'completed') {
      const summary = payload.summary && payload.summary.trim().length > 0 ? ` ${payload.summary.trim()}` : '';
      const pushable =
        payload.committed && payload.branch
          ? ` The work is on branch ${payload.branch} — say "push it" to push, or "open a PR".`
          : '';
      line = `Done on ${origin.deviceName} (${origin.workspaceName}).${summary}${pushable}`;
    } else if (payload.status === 'cancelled') {
      line = `Session on ${origin.deviceName} (${origin.workspaceName}) was cancelled.`;
    } else {
      const why = payload.error && payload.error.trim().length > 0 ? `: ${payload.error.trim()}` : '';
      line = `Session on ${origin.deviceName} (${origin.workspaceName}) failed${why}.`;
    }
    await this.deliver(origin, line);
  }

  /**
   * Post one assistant line into the origin conversation (so the in-app/web thread shows it live) and,
   * when the medium is WhatsApp, additionally push it into the user's self-chat. Posting to the
   * conversation only emits a socket event — it never itself sends to WhatsApp — so the two deliveries
   * never double up.
   */
  private async deliver(origin: RunnerOrigin, text: string): Promise<void> {
    try {
      const message = await messageRepository.create({
        conversationId: origin.conversationId,
        senderId: null,
        senderKind: 'assistant',
        type: 'text',
        content: text,
      });
      const event: StewraReplyEvent = { message };
      emitToConversation(origin.conversationId, SERVER_EVENTS.STEWRA_REPLY, event);
      if (origin.channel === 'whatsapp') {
        await whatsappBridgeService.sendUnsolicitedSelfChat(origin.userId, text);
      }
    } catch (err: unknown) {
      logger.warn('runner chat relay failed', { err: String(err), conversationId: origin.conversationId });
    }
  }
}

export const runnerChatRelayService = new RunnerChatRelayService();
