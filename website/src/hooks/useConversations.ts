import { useCallback, useEffect, useState } from 'react';
import { SERVER_EVENTS } from '@stewra/shared-types';
import type { ConversationSummary } from '@stewra/shared-types';
import { api } from '../services/api';
import { useSocket } from './useSocket';

interface UseConversationsResult {
  readonly conversations: ReadonlyArray<ConversationSummary>;
  readonly loading: boolean;
  readonly error: string | null;
  reload: () => Promise<void>;
}

/**
 * Loads the caller's conversation list and keeps it live: an incoming `chat:message` bumps the relevant
 * conversation to the top with a refreshed last-message preview + unread count (by reloading the list —
 * simple and correct for v1; the list is small). Returns a manual `reload` for pull-to-refresh.
 */
export function useConversations(): UseConversationsResult {
  const socket = useSocket();
  const [conversations, setConversations] = useState<ReadonlyArray<ConversationSummary>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listConversations();
      setConversations(res.conversations);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!socket) {
      return;
    }
    const onMessage = (): void => {
      void reload();
    };
    socket.on(SERVER_EVENTS.CHAT_MESSAGE, onMessage);
    return () => {
      socket.off(SERVER_EVENTS.CHAT_MESSAGE, onMessage);
    };
  }, [socket, reload]);

  return { conversations, loading, error, reload };
}
