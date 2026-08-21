import { SERVER_EVENTS } from '@stewra/shared-types';
import type {
  RunnerPermissionPromptPayload,
  RunnerSessionDonePayload,
  StewraReplyEvent,
} from '@stewra/shared-types';
import * as Sentry from '@sentry/node';
import { messageRepository } from '../repositories/messageRepository.js';
import { runnerChatRelayRepository } from '../repositories/runnerChatRelayRepository.js';
import type { PendingRunnerPermission, RunnerOrigin } from '../repositories/runnerChatRelayRepository.js';
import { emitToConversation } from '../websocket/emitter.js';
import { whatsappBridgeService } from './whatsappBridgeService.js';
import { logger } from '../utils/logger.js';
import { summaryInWords, errorInWords } from './runnerVoice.js';

export type { PendingRunnerPermission, RunnerOrigin } from '../repositories/runnerChatRelayRepository.js';
/**
 * Which medium a chat-initiated runner session is being watched on, so its later, unsolicited moments
 * (a permission gate, the final result) are relayed back to the SAME place the user asked from — the
 * core "ask on WhatsApp, get answered on WhatsApp" property. `stewra_chat` is the in-app/web Stewra
 * thread (a live socket); `whatsapp` additionally pushes the line into the user's self-chat.
 */
export type { RunnerChatChannel } from '../repositories/runnerChatRelayRepository.js';

/**
 * Bridges a runner session's async lifecycle back into the CHAT the user started it from.
 *
 * The socket already streams every `runner-ui:*` event to the fleet page; this service is the parallel
 * path for the conversational surfaces (WhatsApp, and the Stewra chat thread) that don't hold that
 * page open. It relays only the moments that need the human — a permission request and the final
 * result — so a button-less channel stays quiet until it actually needs a reply, and it remembers the
 * pending permission so a plain "yes" resolves against it.
 *
 * Both facts are rows (migration 066), not fields on this object: a backend restart mid-session must
 * not lose the WhatsApp target, because a founder driving a session from their phone has no other
 * surface to notice the gate on. Every method is therefore async.
 */
export class RunnerChatRelayService {
  /** Remember where a session's relayed lines should go. Called when a session is started from a chat. */
  async registerOrigin(sessionId: string, origin: RunnerOrigin): Promise<void> {
    await runnerChatRelayRepository.saveOrigin(sessionId, origin);
  }

  /** The most recent permission a session of this user is blocked on, or null. */
  latestPendingPermission(userId: string): Promise<PendingRunnerPermission | null> {
    return runnerChatRelayRepository.latestPendingForUser(userId);
  }

  /** Forget a session's pending permission once it has been decided. */
  async clearPermission(sessionId: string): Promise<void> {
    await runnerChatRelayRepository.deletePending(sessionId);
  }

  /**
   * A runner hit a permission gate. Remember it (so a "yes" can resolve) and, if the session is being
   * watched from a chat, relay a natural-language ask to that medium. Best-effort on delivery: a relay
   * failure must never stop the socket path that already delivered the prompt to the fleet page.
   */
  async onPermission(userId: string, payload: RunnerPermissionPromptPayload): Promise<void> {
    const allow = payload.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
    const deny = payload.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
    await runnerChatRelayRepository.savePending({
      userId,
      sessionId: payload.sessionId,
      promptId: payload.promptId,
      allowOptionId: allow?.id ?? null,
      denyOptionId: deny?.id ?? null,
      title: payload.title,
    });

    const origin = await runnerChatRelayRepository.findOrigin(payload.sessionId);
    if (origin === null) return;
    // The agent's title and detail are usually the same words; say them once.
    const title = payload.title.trim();
    const detail = payload.detail.trim();
    const step = detail.length > 0 && detail !== title ? `${title} — ${detail}` : title;
    const line = `${subject(origin)} needs your OK for one step: ${step}. Shall I let it? (yes / no)`;
    await this.deliver(origin, line);
  }

  /**
   * A session finished. Relay a short, medium-appropriate summary (and, when there is committed work, a
   * nudge that it can be pushed by just saying so) to the chat it came from, then forget it.
   */
  async onDone(payload: RunnerSessionDonePayload): Promise<void> {
    const origin = await runnerChatRelayRepository.findOrigin(payload.sessionId);
    await runnerChatRelayRepository.deletePending(payload.sessionId);
    if (origin === null) return;
    await runnerChatRelayRepository.deleteOrigin(payload.sessionId);

    const what = subject(origin);
    let line: string;
    if (payload.status === 'completed') {
      const summary = summaryInWords(payload.summary);
      const note = summary.length > 0 ? ` ${summary}` : '';
      const next =
        payload.committed && payload.branch
          ? ` The changes are saved on branch ${payload.branch}. Say "push it" and I'll push them, or "open a PR".`
          : ' There were no changes to save.';
      line = `All done — ${what} on ${origin.deviceName} has finished.${note}${next}`;
    } else if (payload.status === 'cancelled') {
      line = `Stopped the work on ${what} (${origin.deviceName}), as asked.`;
    } else {
      const why = payload.error && payload.error.trim().length > 0 ? ` — ${errorInWords(payload.error)}` : '';
      line = `I'm sorry — the work on ${what} (${origin.deviceName}) didn't finish${why}. The Fleet page has the full log if you'd like to see what happened.`;
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
      // This catch is the end of the line for a message the runner produced: it is not retried and the
      // user is never told it existed. Silence here reads as "the runner had nothing to say".
      Sentry.captureException(err, {
        tags: { surface: 'runner_chat_relay' },
        extra: { conversationId: origin.conversationId, userId: origin.userId },
      });
      logger.warn('runner chat relay failed', { err: String(err), conversationId: origin.conversationId });
    }
  }
}

/** What the person called it: the project when there is one, else the checkout. */
function subject(origin: RunnerOrigin): string {
  return origin.projectName ?? origin.workspaceName;
}

export const runnerChatRelayService = new RunnerChatRelayService();
