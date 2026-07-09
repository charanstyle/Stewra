import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { CallKind, ConversationSummary, Message, PublicUser } from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { Avatar } from '../../components/Avatar/Avatar';
import { MessageStatusIndicator } from '../../components/chat/MessageStatusIndicator';
import { TypingIndicator } from '../../components/chat/TypingIndicator';
import { ReadReceiptModal } from '../../components/chat/ReadReceiptModal';
import { useAuth } from '../../hooks/useAuth';
import { useChat } from '../../hooks/useChat';
import { usePresence } from '../../hooks/usePresence';
import { useCall } from '../../hooks/CallContext';
import { api } from '../../services/api';
import { playMessageAudio } from '../../services/stewraVoice';
import { PhoneIcon, VideoIcon, PlayIcon } from '../../components/icons/Icons';
import styles from './ConversationPage.module.css';

/** Human-facing text for a system marker — call markers distinguish voice vs video (and show duration). */
function systemLabel(message: Message): string {
  const kind = message.mediaType === 'video' ? 'Video call' : 'Voice call';
  if (message.type === 'call_start') {
    return `${kind} started`;
  }
  if (message.type === 'call_end') {
    return message.mediaDurationSec != null
      ? `${kind} ended (${message.mediaDurationSec}s)`
      : `${kind} ended`;
  }
  return message.content ?? '—';
}

/** "Online" or a relative "last seen …" line for the header of a 1:1 conversation. */
function lastSeenLabel(lastActiveAt: string): string {
  const then = new Date(lastActiveAt);
  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${then.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

/** Renders one message bubble, aligned right when the caller authored it. */
function MessageBubble({
  message,
  mine,
  isLastInGroup,
  readers,
  onOpenReceipts,
}: {
  message: Message;
  mine: boolean;
  isLastInGroup: boolean;
  readers: ReadonlyArray<PublicUser>;
  onOpenReceipts: (message: Message) => void;
}): React.JSX.Element {
  const isSystem =
    message.type === 'call_start' || message.type === 'call_end' || message.type === 'system';
  if (isSystem) {
    return <div className={styles.systemMsg}>{systemLabel(message)}</div>;
  }
  // The read-by decoration: the readers' small avatars under the last message of a same-sender run,
  // shown only once that message has actually been read (positional, not a separate data concept).
  const showReadBy = mine && isLastInGroup && message.status === 'read' && readers.length > 0;
  return (
    <div className={styles.bubbleRow}>
      <div
        className={mine ? styles.bubbleMine : styles.bubbleTheirs}
        onClick={mine ? () => onOpenReceipts(message) : undefined}
        role={mine ? 'button' : undefined}
        tabIndex={mine ? 0 : undefined}
      >
        {message.transcript && message.type === 'voice' && (
          <span className={styles.voiceTag}>Voice</span>
        )}
        <span>{message.content ?? message.transcript ?? ''}</span>
        {message.audioUrl && (
          <button
            type="button"
            className={styles.playBtn}
            title="Play audio"
            onClick={(e) => {
              e.stopPropagation();
              void playMessageAudio(message.audioUrl ?? '');
            }}
          >
            <PlayIcon size={14} />
            Play
          </button>
        )}
        <span className={styles.bubbleTime}>
          {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {mine && <MessageStatusIndicator status={message.status} />}
        </span>
      </div>
      {showReadBy && (
        <div className={styles.readBy}>
          {readers.map((r) => (
            <Avatar key={r.id} name={r.displayName} avatarUrl={r.avatarUrl} size={16} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ConversationPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const conversationId = id ?? null;
  const navigate = useNavigate();
  const { user } = useAuth();
  const { startCall } = useCall();
  const { messages, loading, error, typingUserIds, sendText, setTyping } = useChat(conversationId);

  const [summary, setSummary] = useState<ConversationSummary | null>(null);
  const [draft, setDraft] = useState('');
  const [receiptsFor, setReceiptsFor] = useState<Message | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const participants = summary?.participants ?? [];
  const participantIds = participants.map((p) => p.id);
  const presence = usePresence(participantIds);

  useEffect(() => {
    if (conversationId === null) {
      return;
    }
    api
      .getConversation(conversationId)
      .then((res) => setSummary(res.conversation))
      .catch(() => setSummary(null));
  }, [conversationId]);

  // Keep the view pinned to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const onDraftChange = useCallback(
    (value: string): void => {
      setDraft(value);
      setTyping(true);
      if (typingTimer.current) {
        clearTimeout(typingTimer.current);
      }
      typingTimer.current = setTimeout(() => setTyping(false), 1500);
    },
    [setTyping],
  );

  const submit = useCallback(async (): Promise<void> => {
    const content = draft.trim();
    if (content === '') {
      return;
    }
    setDraft('');
    setTyping(false);
    await sendText(content);
  }, [draft, sendText, setTyping]);

  const peer = participants[0] ?? null;
  const title =
    summary?.conversation.title ??
    participants.map((p) => p.displayName).join(', ') ??
    'Conversation';
  const isDirect = summary?.conversation.type === 'direct';
  const canCall = isDirect && peer !== null;
  const peerPresence = peer ? presence.get(peer.id) : undefined;
  const peerOnline = peerPresence?.status === 'online';

  const byId = new Map(participants.map((p) => [p.id, p]));

  const placeCall = useCallback(
    (kind: CallKind): void => {
      if (summary === null || peer === null) {
        return;
      }
      void startCall(summary.conversation.id, kind, peer.id);
    },
    [summary, peer, startCall],
  );

  return (
    <div className={styles.page}>
      <AppNav />
      <div className={styles.convHeader}>
        <button type="button" className={styles.back} onClick={() => navigate('/chats')}>
          ‹ Back
        </button>
        {peer && <Avatar name={peer.displayName} avatarUrl={peer.avatarUrl} size={34} />}
        <div className={styles.headerText}>
          <span className={styles.convTitle}>{title}</span>
          {isDirect && (
            <span className={styles.presence}>
              {peerOnline ? (
                <>
                  <span className={styles.onlineDot} /> Online
                </>
              ) : peerPresence ? (
                lastSeenLabel(peerPresence.lastActiveAt)
              ) : (
                'Offline'
              )}
            </span>
          )}
        </div>
        <div className={styles.callButtons}>
          {canCall && (
            <>
              <button
                type="button"
                className={styles.callBtn}
                title="Audio call"
                onClick={() => placeCall('audio')}
              >
                <PhoneIcon size={16} />
                Call
              </button>
              <button
                type="button"
                className={styles.callBtn}
                title="Video call"
                onClick={() => placeCall('video')}
              >
                <VideoIcon size={16} />
                Video
              </button>
            </>
          )}
        </div>
      </div>

      <div className={styles.messages} ref={scrollRef}>
        {loading && <p className={styles.muted}>Loading messages…</p>}
        {error && <div className={styles.error}>{error}</div>}
        {messages.map((m, i) => {
          const mine = m.senderId === user?.id;
          const next = messages[i + 1];
          const isLastInGroup = next === undefined || next.senderId !== m.senderId;
          const readers = m.readReceipts
            .map((r) => byId.get(r.userId))
            .filter((p): p is PublicUser => p !== undefined);
          return (
            <MessageBubble
              key={m.id}
              message={m}
              mine={mine}
              isLastInGroup={isLastInGroup}
              readers={readers}
              onOpenReceipts={setReceiptsFor}
            />
          );
        })}
        {typingUserIds.length > 0 && <TypingIndicator />}
      </div>

      <div className={styles.composer}>
        <input
          className={styles.input}
          value={draft}
          placeholder="Type a message"
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button type="button" className={styles.send} onClick={() => void submit()}>
          Send
        </button>
      </div>

      {receiptsFor && (
        <ReadReceiptModal
          message={receiptsFor}
          participants={participants}
          onClose={() => setReceiptsFor(null)}
        />
      )}
    </div>
  );
}
