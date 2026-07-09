import { SERVER_EVENTS } from '@stewra/shared-types';
import type { ChatDeliveredEvent, Conversation, Message, Paginated, ReactionType, ReadReceipt } from '@stewra/shared-types';
import { messageRepository, MessageRepository } from '../repositories/messageRepository';
import { conversationService } from './conversationService';
import { mediaService } from './mediaService';
import { sttService } from './sttService';
import { stewraConversationService } from './stewraConversationService';
import { presenceService } from './presenceService';
import { emitToUser } from '../websocket/emitter';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_CONTENT_LENGTH = 8000;

/** The outcome of a voice turn: the caller's transcribed message, plus Stewra's reply for a Stewra-AI thread. */
export interface VoiceTurnResult {
  readonly conversation: Conversation;
  readonly userMessage: Message;
  readonly assistantMessage: Message | null;
}

/**
 * Human↔human (and user-side Stewra-AI) message writes/reads. Every operation is gated by
 * `conversationService.assertParticipant`. Persistence is the source of truth here; the socket notify
 * (emit to the conversation room) is the controller's job after this returns.
 */
class MessageService {
  /**
   * Send a text message to a conversation the caller is an active participant of. Returns the stored
   * message plus the conversation, so the controller can tell a Stewra-AI thread (which owes an
   * assistant reply) from a human one and fan out accordingly.
   */
  async sendText(
    userId: string,
    conversationId: string,
    content: string,
    replyToId: string | null,
  ): Promise<{ message: Message; conversation: Conversation }> {
    const { conversation } = await conversationService.assertParticipant(userId, conversationId);
    const trimmed = content.trim();
    if (trimmed.length === 0) throw new ValidationError('Message content cannot be empty');
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      throw new ValidationError(`Message content exceeds ${MAX_CONTENT_LENGTH} characters`);
    }
    const message = await messageRepository.create({
      conversationId,
      senderId: userId,
      senderKind: MessageRepository.SENDER_USER,
      type: 'text',
      content: trimmed,
      replyToId,
    });
    return { message, conversation };
  }

  /**
   * Produce Stewra's reply to a just-persisted user text turn in the user's Stewra-AI conversation
   * (advice-only converse → text + optional TTS). Thin pass-through to the control-plane orchestrator;
   * the caller (controller) owns fan-out and runs this off the request path so the POST stays fast.
   */
  async generateStewraReply(
    userId: string,
    conversation: Conversation,
    userMessage: Message,
  ): Promise<Message> {
    return stewraConversationService.generateReply(userId, conversation, userMessage);
  }

  /**
   * A spoken turn: transcribe the uploaded clip (whisper.cpp), store it as an owner-scoped `voice_in`
   * asset, and persist the caller's `voice` message (transcript + audio). In the user's Stewra-AI
   * conversation it then produces Stewra's reply (text + TTS audio) via the control-plane orchestrator;
   * in a human conversation `assistantMessage` is null (it's just a voice note). Gated by
   * `assertParticipant` like every other write.
   */
  async sendVoice(
    userId: string,
    conversationId: string,
    audio: { buffer: Buffer; mime: string },
  ): Promise<VoiceTurnResult> {
    const { conversation } = await conversationService.assertParticipant(userId, conversationId);

    const ext = mediaService.extensionForMime(audio.mime);
    const { filename, absPath } = await mediaService.reserve(ext);
    await mediaService.writeBuffer(absPath, audio.buffer);
    const transcript = await sttService.transcribe(absPath);
    const asset = await mediaService.record({
      ownerId: userId,
      conversationId,
      kind: 'voice_in',
      filename,
      mime: audio.mime,
      bytes: audio.buffer.length,
    });

    const userMessage = await messageRepository.create({
      conversationId,
      senderId: userId,
      senderKind: MessageRepository.SENDER_USER,
      type: 'voice',
      content: null,
      transcript,
      audioUrl: mediaService.urlFor(asset),
    });

    const assistantMessage =
      conversation.type === 'stewra_ai'
        ? await stewraConversationService.generateReply(userId, conversation, userMessage)
        : null;

    return { conversation, userMessage, assistantMessage };
  }

  /**
   * Stamp a just-sent message delivered if any OTHER active participant is currently online, and return
   * a delivered event per online recipient so the controller can notify the room. Delivery is
   * best-effort presence-at-send-time; recipients offline now get their tick when they next fetch (the
   * stored delivered_at is authoritative). Returns an empty array when nobody is online.
   */
  async markDeliveredToOnline(message: Message): Promise<ChatDeliveredEvent[]> {
    const senderId = message.senderId;
    const otherIds = await conversationService.otherActiveParticipantIds(
      senderId ?? '',
      message.conversationId,
    );
    if (otherIds.length === 0) return [];
    const statuses = await presenceService.statuses(otherIds);
    const online = statuses.filter((s) => s.status === 'online').map((s) => s.userId);
    if (online.length === 0) return [];
    const deliveredAt = await messageRepository.markDelivered(message.id);
    if (deliveredAt === null) return [];
    const iso = deliveredAt.toISOString();
    return online.map((userId) => ({
      conversationId: message.conversationId,
      messageId: message.id,
      userId,
      deliveredAt: iso,
    }));
  }

  /** Page a conversation's messages newest-first (caller must be a participant). */
  async list(
    userId: string,
    conversationId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<Paginated<Message>> {
    await conversationService.assertParticipant(userId, conversationId);
    const capped = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    return messageRepository.listByConversation(conversationId, cursor, capped, userId);
  }

  /**
   * On a user's socket connect, stamp delivered_at for every message that arrived while they were
   * offline and notify each affected sender (their ticks advance sent→delivered without the recipient
   * opening the thread). Best-effort: a missing socket bus just means no live tick, the stamp persists.
   */
  async markPendingDeliveredOnConnect(userId: string): Promise<void> {
    const delivered = await messageRepository.markPendingDeliveredForUser(userId);
    for (const d of delivered) {
      const event: ChatDeliveredEvent = {
        conversationId: d.conversationId,
        messageId: d.messageId,
        userId,
        deliveredAt: d.deliveredAt,
      };
      emitToUser(d.senderId, SERVER_EVENTS.CHAT_MESSAGE_DELIVERED, event);
    }
  }

  /**
   * The per-participant read acknowledgements for one message (for the read-receipt detail view). The
   * caller must be an active participant of the message's conversation. Receipts already exclude the
   * message's own sender (only other readers ever get a row).
   */
  async listReceipts(userId: string, messageId: string): Promise<ReadReceipt[]> {
    const message = await messageRepository.findById(messageId, userId);
    if (message === undefined) throw new NotFoundError('Message not found');
    await conversationService.assertParticipant(userId, message.conversationId);
    return messageRepository.listReceipts(messageId);
  }

  /** Add or retract a reaction on a message in a conversation the caller participates in. */
  async react(
    userId: string,
    messageId: string,
    reactionType: ReactionType,
    remove: boolean,
  ): Promise<Message> {
    const message = await messageRepository.findById(messageId, userId);
    if (message === undefined) throw new NotFoundError('Message not found');
    await conversationService.assertParticipant(userId, message.conversationId);
    if (remove) {
      await messageRepository.removeReaction(messageId, userId, reactionType);
    } else {
      await messageRepository.addReaction(messageId, userId, reactionType);
    }
    const updated = await messageRepository.findById(messageId, userId);
    if (updated === undefined) throw new NotFoundError('Message not found');
    return updated;
  }

  /** Soft-delete a message the caller authored. */
  async delete(userId: string, messageId: string): Promise<void> {
    const message = await messageRepository.findById(messageId, userId);
    if (message === undefined) throw new NotFoundError('Message not found');
    await conversationService.assertParticipant(userId, message.conversationId);
    const deleted = await messageRepository.softDelete(messageId, userId);
    if (!deleted) throw new ForbiddenError('You can only delete your own messages');
  }
}

export const messageService = new MessageService();
