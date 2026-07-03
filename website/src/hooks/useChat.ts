import { useCallback, useEffect, useRef, useState } from 'react';
import { CLIENT_EVENTS, SERVER_EVENTS } from '@stewra/shared-types';
import type { Message, UUID } from '@stewra/shared-types';
import { api } from '../services/api';
import { useSocket } from './useSocket';

interface TypingUser {
  readonly userId: UUID;
}

interface UseChatResult {
  readonly messages: ReadonlyArray<Message>;
  readonly loading: boolean;
  readonly error: string | null;
  /** User ids currently typing in this conversation (excludes the caller). */
  readonly typingUserIds: ReadonlyArray<UUID>;
  /** Stewra-AI thread only: the assistant is composing a reply (drives a "thinking…" indicator). */
  readonly stewraThinking: boolean;
  /** Stewra-AI thread only: the last assistant turn failed to generate (retryable notice). */
  readonly stewraError: string | null;
  sendText: (content: string) => Promise<void>;
  /** Notify the room the caller started/stopped typing (debounced by the caller). */
  setTyping: (isTyping: boolean) => void;
  /** Append a locally-produced message (e.g. the voice turn + assistant reply) without a reload. */
  appendMessages: (messages: ReadonlyArray<Message>) => void;
}

/**
 * Owns one conversation's live message list: loads the newest page over REST, joins the socket room,
 * appends incoming `chat:message`/`stewra:reply` events, tracks typing, and marks the newest message
 * read on arrival. De-dupes by message id so an echoed optimistic/own message never doubles up.
 */
export function useChat(conversationId: UUID | null): UseChatResult {
  const socket = useSocket();
  const [messages, setMessages] = useState<ReadonlyArray<Message>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState<ReadonlyArray<TypingUser>>([]);
  const [stewraThinking, setStewraThinking] = useState(false);
  const [stewraError, setStewraError] = useState<string | null>(null);
  const seenIds = useRef<Set<UUID>>(new Set());

  const upsert = useCallback((incoming: ReadonlyArray<Message>): void => {
    setMessages((prev) => {
      const next = [...prev];
      for (const msg of incoming) {
        if (seenIds.current.has(msg.id)) {
          const idx = next.findIndex((m) => m.id === msg.id);
          if (idx >= 0) {
            next[idx] = msg;
          }
        } else {
          seenIds.current.add(msg.id);
          next.push(msg);
        }
      }
      next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return next;
    });
  }, []);

  // Initial load (newest page, returned newest-first → reverse to chronological).
  useEffect(() => {
    if (conversationId === null) {
      return;
    }
    setLoading(true);
    seenIds.current = new Set();
    setMessages([]);
    api
      .listMessages(conversationId, { limit: 50 })
      .then((res) => {
        const chronological = [...res.messages.items].reverse();
        seenIds.current = new Set(chronological.map((m) => m.id));
        setMessages(chronological);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load messages'))
      .finally(() => setLoading(false));
  }, [conversationId]);

  // Join the room and subscribe to live events.
  useEffect(() => {
    if (!socket || conversationId === null) {
      return;
    }
    socket.emit(CLIENT_EVENTS.CHAT_JOIN, { conversationId }, () => undefined);

    const onMessage = (event: { message: Message }): void => {
      if (event.message.conversationId === conversationId) {
        upsert([event.message]);
      }
    };
    const onReply = (event: { message: Message }): void => {
      if (event.message.conversationId === conversationId) {
        setStewraThinking(false);
        setStewraError(null);
        upsert([event.message]);
      }
    };
    const onStewraThinking = (event: { conversationId: UUID }): void => {
      if (event.conversationId === conversationId) {
        setStewraError(null);
        setStewraThinking(true);
      }
    };
    const onStewraError = (event: { conversationId: UUID; message: string }): void => {
      if (event.conversationId === conversationId) {
        setStewraThinking(false);
        setStewraError(event.message);
      }
    };
    const onTyping = (event: { conversationId: UUID; userId: UUID; isTyping: boolean }): void => {
      if (event.conversationId !== conversationId) {
        return;
      }
      setTyping((prev) => {
        const without = prev.filter((t) => t.userId !== event.userId);
        return event.isTyping ? [...without, { userId: event.userId }] : without;
      });
    };

    socket.on(SERVER_EVENTS.CHAT_MESSAGE, onMessage);
    socket.on(SERVER_EVENTS.STEWRA_REPLY, onReply);
    socket.on(SERVER_EVENTS.STEWRA_THINKING, onStewraThinking);
    socket.on(SERVER_EVENTS.STEWRA_ERROR, onStewraError);
    socket.on(SERVER_EVENTS.CHAT_TYPING, onTyping);
    return () => {
      socket.emit(CLIENT_EVENTS.CHAT_LEAVE, { conversationId }, () => undefined);
      socket.off(SERVER_EVENTS.CHAT_MESSAGE, onMessage);
      socket.off(SERVER_EVENTS.STEWRA_REPLY, onReply);
      socket.off(SERVER_EVENTS.STEWRA_THINKING, onStewraThinking);
      socket.off(SERVER_EVENTS.STEWRA_ERROR, onStewraError);
      socket.off(SERVER_EVENTS.CHAT_TYPING, onTyping);
    };
  }, [socket, conversationId, upsert]);

  // Mark the newest message read whenever the tail advances.
  useEffect(() => {
    if (conversationId === null || messages.length === 0) {
      return;
    }
    const newest = messages[messages.length - 1];
    void api.markConversationRead(conversationId, newest.id).catch(() => undefined);
  }, [conversationId, messages]);

  const sendText = useCallback(
    async (content: string): Promise<void> => {
      if (conversationId === null || content.trim() === '') {
        return;
      }
      const res = await api.sendMessage({ conversationId, type: 'text', content });
      upsert([res.message]);
    },
    [conversationId, upsert],
  );

  const emitTyping = useCallback(
    (isTyping: boolean): void => {
      if (socket && conversationId !== null) {
        socket.emit(CLIENT_EVENTS.CHAT_TYPING, { conversationId, isTyping }, () => undefined);
      }
    },
    [socket, conversationId],
  );

  return {
    messages,
    loading,
    error,
    typingUserIds: typing.map((t) => t.userId),
    stewraThinking,
    stewraError,
    sendText,
    setTyping: emitTyping,
    appendMessages: upsert,
  };
}
