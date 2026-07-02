import { z } from 'zod';
import { CLIENT_EVENTS, SERVER_EVENTS } from '@stewra/shared-types';
import type { ChatReadEvent, ChatTypingEvent, ReadReceipt } from '@stewra/shared-types';
import { conversationService } from '../services/conversationService';
import { BaseSocketHandler } from './baseSocketHandler';
import { conversationRoom } from './types';

const JoinSchema = z.object({ conversationId: z.string().uuid() });
const TypingSchema = z.object({
  conversationId: z.string().uuid(),
  isTyping: z.boolean(),
});
const MarkReadSchema = z.object({
  conversationId: z.string().uuid(),
  upToMessageId: z.string().uuid(),
});

/**
 * Ephemeral chat channel: join/leave a conversation's fan-out room, typing indicators, and the live
 * read watermark. All PERSISTENCE (sending messages, reactions) goes through REST — this handler only
 * moves transient signals and the durable read watermark. Every action re-checks membership via
 * `assertParticipant` so a stale socket can't peek into a conversation the user has left.
 */
export class ChatHandler extends BaseSocketHandler {
  register(): void {
    // Join a conversation's room after verifying active membership.
    this.on(CLIENT_EVENTS.CHAT_JOIN, JoinSchema, async (payload, ack) => {
      await conversationService.assertParticipant(this.userId, payload.conversationId);
      await this.socket.join(conversationRoom(payload.conversationId));
      if (typeof ack === 'function') ack({ ok: true });
    });

    // Leave the room (does NOT soft-leave the conversation in the DB — that's a REST action).
    this.on(CLIENT_EVENTS.CHAT_LEAVE, JoinSchema, async (payload, ack) => {
      await this.socket.leave(conversationRoom(payload.conversationId));
      if (typeof ack === 'function') ack({ ok: true });
    });

    // Broadcast a typing indicator to the other members of the room (never echoed to the sender).
    this.on(CLIENT_EVENTS.CHAT_TYPING, TypingSchema, async (payload, ack) => {
      await conversationService.assertParticipant(this.userId, payload.conversationId);
      const event: ChatTypingEvent = {
        conversationId: payload.conversationId,
        userId: this.userId,
        isTyping: payload.isTyping,
      };
      this.socket.to(conversationRoom(payload.conversationId)).emit(SERVER_EVENTS.CHAT_TYPING, event);
      if (typeof ack === 'function') ack({ ok: true });
    });

    // Advance the durable read watermark and notify the room.
    this.on(CLIENT_EVENTS.CHAT_MARK_READ, MarkReadSchema, async (payload, ack) => {
      const at = await conversationService.markRead(
        this.userId,
        payload.conversationId,
        payload.upToMessageId,
      );
      const receipt: ReadReceipt = {
        messageId: payload.upToMessageId,
        userId: this.userId,
        readAt: at.toISOString(),
      };
      const event: ChatReadEvent = { conversationId: payload.conversationId, receipts: [receipt] };
      this.socket
        .to(conversationRoom(payload.conversationId))
        .emit(SERVER_EVENTS.CHAT_MESSAGE_READ, event);
      if (typeof ack === 'function') ack({ ok: true, lastReadAt: receipt.readAt });
    });
  }
}
