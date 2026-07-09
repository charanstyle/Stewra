import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ConversationSummary } from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { useConversations } from '../../hooks/useConversations';
import { usePresence } from '../../hooks/usePresence';
import styles from './ChatsPage.module.css';

/** Human-facing title for a conversation row (group title, or the other participant's name for 1:1). */
function titleFor(summary: ConversationSummary): string {
  if (summary.conversation.title) {
    return summary.conversation.title;
  }
  const names = summary.participants.map((p) => p.displayName);
  return names.length > 0 ? names.join(', ') : 'Conversation';
}

export default function ChatsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { conversations, loading, error } = useConversations();

  // Watch presence for every 1:1 counterpart so the list can show an online dot.
  const peerIds = useMemo(
    () =>
      conversations
        .filter((c) => c.conversation.type === 'direct')
        .flatMap((c) => c.participants.map((p) => p.id)),
    [conversations],
  );
  const presence = usePresence(peerIds);

  return (
    <div className={styles.page}>
      <AppNav />
      <main className={styles.main}>
        <div className={styles.headerRow}>
          <h1 className={styles.title}>Chats</h1>
          <button type="button" className={styles.primary} onClick={() => navigate('/contacts')}>
            New chat
          </button>
        </div>

        {error && <div className={styles.error}>{error}</div>}
        {loading && <p className={styles.muted}>Loading conversations…</p>}
        {!loading && conversations.length === 0 && (
          <p className={styles.muted}>
            No conversations yet. Head to <strong>Contacts</strong> to connect with someone, or{' '}
            <strong>Talk to Stewra</strong> to start a voice chat with your assistant.
          </p>
        )}

        <ul className={styles.list}>
          {conversations.map((summary) => {
            const peer = summary.participants[0];
            const online = peer && presence.get(peer.id)?.status === 'online';
            return (
              <li
                key={summary.conversation.id}
                className={styles.row}
                onClick={() => navigate(`/chats/${summary.conversation.id}`)}
              >
                <div className={styles.avatar}>
                  {titleFor(summary).charAt(0).toUpperCase()}
                  {online && <span className={styles.onlineDot} />}
                </div>
                <div className={styles.rowBody}>
                  <div className={styles.rowTop}>
                    <span className={styles.rowTitle}>{titleFor(summary)}</span>
                    {summary.lastMessage && (
                      <span className={styles.rowTime}>
                        {new Date(summary.lastMessage.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                  <div className={styles.rowBottom}>
                    <span className={styles.preview}>
                      {summary.lastMessage?.preview ?? 'No messages yet'}
                    </span>
                    {summary.unreadCount > 0 && (
                      <span className={styles.unread}>{summary.unreadCount}</span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
