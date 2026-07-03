import type { Request, Response } from 'express';
import { z } from 'zod';
import * as Sentry from '@sentry/node';
import {
  SERVER_EVENTS,
  type ChatDeliveredEvent,
  type ChatMessageEvent,
  type ChatReactionEvent,
  type Conversation,
  type DeleteMessageResponse,
  type ListMessagesResponse,
  type Message,
  type MessageReaction,
  type ReactResponse,
  type ReactionType,
  type SendMessageResponse,
  type SendVoiceMessageResponse,
  type StewraErrorEvent,
  type StewraReplyEvent,
  type StewraThinkingEvent,
} from '@stewra/shared-types';
import { BaseController } from './baseController';
import { messageService } from '../services/messageService';
import { config } from '../config/unifiedConfig';
import { emitToConversation } from '../websocket/emitter';
import { ServiceUnavailableError, ValidationError } from '../utils/errors';
import { parse } from '../utils/validate';
import { logger } from '../utils/logger';

// Zod enum needs a non-empty tuple; derive it from the shared REACTION_TYPES source of truth.
const REACTION_VALUES: [ReactionType, ...ReactionType[]] = ['like', 'love', 'haha', 'wow', 'sad', 'angry'];

const sendSchema = z.object({
  conversationId: z.string().uuid(),
  type: z.literal('text'),
  content: z.string().min(1),
  replyToId: z.string().uuid().optional(),
  clientId: z.string().max(128).optional(),
});
const listSchema = z.object({
  conversationId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const idParamsSchema = z.object({ id: z.string().uuid() });
// Multipart text fields for POST /messages/voice (the audio itself arrives as the `audio` file part).
const voiceFieldsSchema = z.object({ conversationId: z.string().uuid() });
const reactSchema = z.object({
  reactionType: z.enum(REACTION_VALUES),
  remove: z.boolean().optional(),
});

/** Messages REST surface (all routes behind requireAuth + requireEmailVerification). */
class MessagesController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** POST /messages — send a text message, then fan it out to the conversation room. */
  async send(req: Request, res: Response): Promise<void> {
    try {
      const userId = this.userId(req);
      const { conversationId, content, replyToId } = parse(sendSchema, req.body);
      const { message, conversation } = await messageService.sendText(
        userId,
        conversationId,
        content,
        replyToId ?? null,
      );
      const event: ChatMessageEvent = { message };
      emitToConversation(conversationId, SERVER_EVENTS.CHAT_MESSAGE, event);

      // Double-tick: if a recipient is already online, stamp delivered and notify the room.
      const delivered: ChatDeliveredEvent[] = await messageService.markDeliveredToOnline(message);
      for (const d of delivered) {
        emitToConversation(conversationId, SERVER_EVENTS.CHAT_MESSAGE_DELIVERED, d);
      }

      const body: SendMessageResponse = { message };
      this.handleSuccess(res, body, 201);

      // A text turn to the user's Stewra-AI thread owes an assistant reply. Generate it OFF the request
      // path (converse can take seconds) so the caller's message renders immediately; the reply arrives
      // over the socket. Emit a "thinking" ping first so the client can show an indicator.
      if (conversation.type === 'stewra_ai') {
        this.dispatchStewraReply(userId, conversation, message);
      }
    } catch (error) {
      this.handleError(error, res, 'MessagesController.send');
    }
  }

  /**
   * Fire-and-forget the Stewra-AI reply for a text turn: emit `stewra:thinking`, run the control-plane
   * converse, then fan out the assistant message as `stewra:reply`. Errors are captured (never crash the
   * process on a background rejection) and surfaced to the room as a thinking-cleared ping.
   */
  private dispatchStewraReply(userId: string, conversation: Conversation, userMessage: Message): void {
    const thinking: StewraThinkingEvent = { conversationId: conversation.id };
    emitToConversation(conversation.id, SERVER_EVENTS.STEWRA_THINKING, thinking);
    void messageService
      .generateStewraReply(userId, conversation, userMessage)
      .then((assistantMessage) => {
        const reply: StewraReplyEvent = { message: assistantMessage };
        emitToConversation(conversation.id, SERVER_EVENTS.STEWRA_REPLY, reply);
      })
      .catch((error) => {
        Sentry.captureException(error);
        logger.error('Stewra reply generation failed', {
          conversationId: conversation.id,
          error: error instanceof Error ? error.message : String(error),
        });
        const failure: StewraErrorEvent = {
          conversationId: conversation.id,
          message: 'Stewra could not reply just now. Please try again.',
        };
        emitToConversation(conversation.id, SERVER_EVENTS.STEWRA_ERROR, failure);
      });
  }

  /**
   * POST /messages/voice — multipart: an audio clip + `conversationId`. Transcribes the clip, stores
   * the caller's voice turn, and (in the Stewra-AI thread) returns Stewra's spoken reply. Fans both
   * messages out to the conversation room. Kill-switched by VOICE_ENABLED (503 when off).
   */
  async sendVoice(req: Request, res: Response): Promise<void> {
    try {
      if (!config.voice.enabled) {
        throw new ServiceUnavailableError('Voice is currently unavailable');
      }
      const userId = this.userId(req);
      const { conversationId } = parse(voiceFieldsSchema, req.body);
      const file = req.file;
      if (file === undefined) throw new ValidationError('An audio file is required');
      if (!file.mimetype.startsWith('audio/')) {
        throw new ValidationError('Uploaded file must be audio');
      }

      const { userMessage, assistantMessage } = await messageService.sendVoice(userId, conversationId, {
        buffer: file.buffer,
        mime: file.mimetype,
      });

      // Fan out the caller's turn; for a human thread, double-tick any online recipient.
      emitToConversation(conversationId, SERVER_EVENTS.CHAT_MESSAGE, { message: userMessage });
      const delivered: ChatDeliveredEvent[] = await messageService.markDeliveredToOnline(userMessage);
      for (const d of delivered) {
        emitToConversation(conversationId, SERVER_EVENTS.CHAT_MESSAGE_DELIVERED, d);
      }
      // Stewra's reply (Stewra-AI thread only) fans out as its own message event.
      if (assistantMessage !== null) {
        emitToConversation(conversationId, SERVER_EVENTS.CHAT_MESSAGE, { message: assistantMessage });
      }

      const body: SendVoiceMessageResponse = { userMessage, assistantMessage };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'MessagesController.sendVoice');
    }
  }

  /** GET /messages?conversationId=&cursor=&limit= — page a conversation newest-first. */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { conversationId, cursor, limit } = parse(listSchema, req.query);
      const messages = await messageService.list(this.userId(req), conversationId, cursor, limit);
      const body: ListMessagesResponse = { messages };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'MessagesController.list');
    }
  }

  /** POST /messages/:id/react — add or retract a reaction, then notify the room. */
  async react(req: Request, res: Response): Promise<void> {
    try {
      const userId = this.userId(req);
      const { id } = parse(idParamsSchema, req.params);
      const { reactionType, remove } = parse(reactSchema, req.body);
      const removed = remove ?? false;
      const message = await messageService.react(userId, id, reactionType, removed);

      const reaction: MessageReaction = {
        messageId: id,
        userId,
        reactionType,
        createdAt: new Date().toISOString(),
      };
      const event: ChatReactionEvent = { reaction, removed };
      emitToConversation(message.conversationId, SERVER_EVENTS.CHAT_REACTION, event);

      const body: ReactResponse = { message };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'MessagesController.react');
    }
  }

  /** DELETE /messages/:id — soft-delete a message the caller authored. */
  async delete(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(idParamsSchema, req.params);
      await messageService.delete(this.userId(req), id);
      const body: DeleteMessageResponse = { messageId: id };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'MessagesController.delete');
    }
  }
}

export const messagesController = new MessagesController();
