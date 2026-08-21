import * as Sentry from '@sentry/node';
import {
  SERVER_EVENTS,
  type ChatMessageEvent,
  type Conversation,
  type Message,
  type StewraErrorEvent,
  type StewraReplyEvent,
  type StewraThinkingEvent,
} from '@stewra/shared-types';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { messageService } from './messageService.js';
import type { RunnerChatChannel } from './runnerChatRelayService.js';
import { emitToConversation } from '../websocket/emitter.js';
import { logger } from '../utils/logger.js';

/**
 * What the user sees in chat when a turn fails; the real cause goes to Sentry, never to the user.
 * Exported so an off-socket channel (WhatsApp) can say the same thing on its own transport.
 */
export const STEWRA_FAILURE_TEXT = 'Stewra could not reply just now. Please try again.';

/**
 * A Talk-to-Stewra turn, independent of the channel it arrived on.
 *
 * Every surface that can carry a user utterance — the REST API, and now the WhatsApp webhook — funnels
 * through here, so a turn is persisted, answered, audited and fanned out to the user's other live
 * clients in exactly ONE way. This previously lived inside `MessagesController`, which meant a second
 * channel would have had to duplicate the socket fan-out and the error handling.
 *
 * Two entry points, because the two callers need opposite things:
 *   - `dispatchReply`  — fire-and-forget. The HTTP caller already has its 201; the reply reaches the
 *                        client over the socket whenever it's ready. Never rejects.
 *   - `handleUserTurn` — awaits the whole turn and RETURNS the assistant message, because a webhook
 *                        channel has to carry the reply back out itself (WhatsApp has no socket).
 * Both fan out over the socket, so a turn taken on WhatsApp shows up live in the web/mobile app.
 */
class StewraTurnService {
  /**
   * Fire-and-forget the assistant reply to an already-persisted user turn: emit `stewra:thinking`, run
   * the control-plane converse, then fan the assistant message out as `stewra:reply`. Errors are
   * captured (a background rejection must never crash the process) and surfaced to the room as a
   * thinking-cleared ping.
   */
  dispatchReply(
    userId: string,
    conversation: Conversation,
    userMessage: Message,
    channel: RunnerChatChannel = 'stewra_chat',
  ): void {
    void this.replyTo(userId, conversation, userMessage, channel).catch(() => {
      // replyTo already captured to Sentry and emitted stewra:error; swallow so this stays fire-and-forget.
    });
  }

  /**
   * A complete turn from a non-socket channel: resolve the user's singleton Stewra-AI conversation,
   * persist their utterance, and return Stewra's persisted reply so the caller can deliver it on the
   * channel it came from. Both messages are fanned out to the conversation room on the way, so the
   * user's web/mobile clients stay in sync with a conversation they're having somewhere else entirely.
   *
   * Rejects if the turn fails — a channel adapter needs to know, so it can tell the user on-channel.
   */
  async handleUserTurn(userId: string, text: string): Promise<Message> {
    const conversation = await conversationRepository.getOrCreateStewra(userId);
    const { message } = await messageService.sendText(userId, conversation.id, text, null);

    const event: ChatMessageEvent = { message };
    emitToConversation(conversation.id, SERVER_EVENTS.CHAT_MESSAGE, event);

    // The only callers of this entry point are the WhatsApp channels; a runner session started from here
    // therefore relays its permission gates and result back to the user's WhatsApp self-chat.
    return this.replyTo(userId, conversation, message, 'whatsapp');
  }

  /**
   * A complete SPOKEN turn from a non-socket channel (a WhatsApp voice note): transcribe it, persist the
   * person's `voice` message, and return both it and Stewra's reply. Same fan-out as `handleUserTurn`,
   * so the transcript and the answer appear live in the web/mobile thread — the person can see what
   * Stewra heard, which is the safety net under acting on speech.
   *
   * Rejects if transcription or the reply fails, after emitting `stewra:error` and capturing to Sentry.
   */
  async handleVoiceTurn(
    userId: string,
    audio: { buffer: Buffer; mime: string },
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    const conversation = await conversationRepository.getOrCreateStewra(userId);
    const thinking: StewraThinkingEvent = { conversationId: conversation.id };
    emitToConversation(conversation.id, SERVER_EVENTS.STEWRA_THINKING, thinking);

    try {
      const { userMessage, assistantMessage } = await messageService.sendVoice(
        userId,
        conversation.id,
        audio,
        'whatsapp',
      );
      if (assistantMessage === null) {
        // The singleton Stewra conversation is always `stewra_ai`, so this is a wiring fault, not a state.
        throw new Error(`voice turn in conversation ${conversation.id} produced no assistant reply`);
      }
      const userEvent: ChatMessageEvent = { message: userMessage };
      emitToConversation(conversation.id, SERVER_EVENTS.CHAT_MESSAGE, userEvent);
      const reply: StewraReplyEvent = { message: assistantMessage };
      emitToConversation(conversation.id, SERVER_EVENTS.STEWRA_REPLY, reply);
      return { userMessage, assistantMessage };
    } catch (error) {
      Sentry.captureException(error);
      logger.error('Stewra voice turn failed', {
        conversationId: conversation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      const failure: StewraErrorEvent = {
        conversationId: conversation.id,
        message: STEWRA_FAILURE_TEXT,
      };
      emitToConversation(conversation.id, SERVER_EVENTS.STEWRA_ERROR, failure);
      throw error;
    }
  }

  /**
   * The shared body of a turn: think → converse → fan out. Emits `stewra:error` and captures to Sentry
   * on failure, then RETHROWS so an awaiting channel adapter can react; `dispatchReply` swallows it.
   */
  private async replyTo(
    userId: string,
    conversation: Conversation,
    userMessage: Message,
    channel: RunnerChatChannel,
  ): Promise<Message> {
    const thinking: StewraThinkingEvent = { conversationId: conversation.id };
    emitToConversation(conversation.id, SERVER_EVENTS.STEWRA_THINKING, thinking);

    try {
      const assistantMessage = await messageService.generateStewraReply(
        userId,
        conversation,
        userMessage,
        channel,
      );
      const reply: StewraReplyEvent = { message: assistantMessage };
      emitToConversation(conversation.id, SERVER_EVENTS.STEWRA_REPLY, reply);
      return assistantMessage;
    } catch (error) {
      Sentry.captureException(error);
      logger.error('Stewra reply generation failed', {
        conversationId: conversation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      const failure: StewraErrorEvent = {
        conversationId: conversation.id,
        message: STEWRA_FAILURE_TEXT,
      };
      emitToConversation(conversation.id, SERVER_EVENTS.STEWRA_ERROR, failure);
      throw error;
    }
  }
}

export const stewraTurnService = new StewraTurnService();
