import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { CallKind, ConversationSummary, Message } from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { useAuth } from '../../hooks/useAuth';
import { useChat } from '../../hooks/useChat';
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

/** Renders one message bubble, aligned right when the caller authored it. */
function MessageBubble({
  message,
  mine,
}: {
  message: Message;
  mine: boolean;
}): React.JSX.Element {
  const isSystem =
    message.type === 'call_start' || message.type === 'call_end' || message.type === 'system';
  if (isSystem) {
    return <div className={styles.systemMsg}>{systemLabel(message)}</div>;
  }
  return (
    <div className={mine ? styles.bubbleMine : styles.bubbleTheirs}>
      {message.transcript && message.type === 'voice' && (
        <span className={styles.voiceTag}>Voice</span>
      )}
      <span>{message.content ?? message.transcript ?? ''}</span>
      {message.audioUrl && (
        <button
          type="button"
          className={styles.playBtn}
          title="Play audio"
          onClick={() => void playMessageAudio(message.audioUrl ?? '')}
        >
          <PlayIcon size={14} />
          Play
        </button>
      )}
      <span className={styles.bubbleTime}>
        {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const peer = summary?.participants[0] ?? null;
  const title =
    summary?.conversation.title ??
    summary?.participants.map((p) => p.displayName).join(', ') ??
    'Conversation';
  const canCall = summary?.conversation.type === 'direct' && peer !== null;

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
        <span className={styles.convTitle}>{title}</span>
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
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} mine={m.senderId === user?.id} />
        ))}
        {typingUserIds.length > 0 && <div className={styles.typing}>typing…</div>}
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
    </div>
  );
}
