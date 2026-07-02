import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { useChat } from '../../hooks/useChat';
import { api, ApiError } from '../../services/api';
import { VoiceRecorder, uploadVoiceTurn, playMessageAudio } from '../../services/stewraVoice';
import { MicIcon, PlayIcon } from '../../components/icons/Icons';
import styles from './StewraPage.module.css';

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

/** One turn in the Stewra conversation — the user's spoken/typed line or Stewra's spoken reply. */
function Turn({ message }: { message: Message }): React.JSX.Element {
  const fromStewra = message.senderKind === 'assistant';
  return (
    <div className={fromStewra ? styles.stewraTurn : styles.userTurn}>
      <div className={styles.turnLabel}>{fromStewra ? 'Stewra' : 'You'}</div>
      <div className={styles.turnText}>{message.content ?? message.transcript ?? ''}</div>
      {message.audioUrl && (
        <button
          type="button"
          className={styles.playBtn}
          onClick={() => void playMessageAudio(message.audioUrl ?? '')}
        >
          <PlayIcon size={14} />
          Play voice
        </button>
      )}
    </div>
  );
}

export default function StewraPage(): React.JSX.Element {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, loading, error, sendText, appendMessages } = useChat(conversationId);

  // Provision (or fetch) the singleton Stewra-AI conversation on mount.
  useEffect(() => {
    api
      .getStewraConversation()
      .then((res) => setConversationId(res.conversation.conversation.id))
      .catch((err) => setProvisionError(describeError(err)));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, thinking]);

  const startRecording = useCallback(async (): Promise<void> => {
    setVoiceError(null);
    try {
      const recorder = new VoiceRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setVoiceError('Microphone access is required to talk to Stewra.');
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (!recorder || conversationId === null) {
      return;
    }
    setRecording(false);
    setThinking(true);
    try {
      const blob = await recorder.stop();
      const res = await uploadVoiceTurn(conversationId, blob);
      const turns: Message[] = [res.userMessage];
      if (res.assistantMessage) {
        turns.push(res.assistantMessage);
      }
      appendMessages(turns);
      // Auto-play Stewra's spoken reply so the exchange is heard, not just read.
      if (res.assistantMessage?.audioUrl) {
        void playMessageAudio(res.assistantMessage.audioUrl);
      }
    } catch (err) {
      setVoiceError(describeError(err));
    } finally {
      recorderRef.current = null;
      setThinking(false);
    }
  }, [conversationId, appendMessages]);

  const submitText = useCallback(async (): Promise<void> => {
    const content = draft.trim();
    if (content === '') {
      return;
    }
    setDraft('');
    await sendText(content);
  }, [draft, sendText]);

  return (
    <div className={styles.page}>
      <AppNav />
      <div className={styles.header}>
        <h1 className={styles.title}>Talk to Stewra</h1>
        <p className={styles.subtitle}>
          Speak or type. Stewra listens, thinks, and replies out loud and in text.
        </p>
      </div>

      {provisionError && <div className={styles.error}>{provisionError}</div>}

      <div className={styles.thread} ref={scrollRef}>
        {loading && <p className={styles.muted}>Loading your conversation…</p>}
        {error && <div className={styles.error}>{error}</div>}
        {!loading && messages.length === 0 && (
          <p className={styles.muted}>
            Say hello — press and hold the mic, or type below. Stewra gives advice; it never acts on your
            behalf.
          </p>
        )}
        {messages.map((m) => (
          <Turn key={m.id} message={m} />
        ))}
        {thinking && <div className={styles.thinking}>Stewra is thinking…</div>}
      </div>

      {voiceError && <div className={styles.error}>{voiceError}</div>}

      <div className={styles.controls}>
        <button
          type="button"
          className={recording ? styles.micActive : styles.mic}
          disabled={conversationId === null || thinking}
          onMouseDown={() => void startRecording()}
          onMouseUp={() => void stopRecording()}
          onMouseLeave={() => recording && void stopRecording()}
        >
          <MicIcon size={18} />
          {recording ? 'Recording — release to send' : 'Hold to talk'}
        </button>
        <div className={styles.textRow}>
          <input
            className={styles.input}
            value={draft}
            placeholder="…or type a message"
            disabled={conversationId === null}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submitText();
              }
            }}
          />
          <button type="button" className={styles.send} onClick={() => void submitText()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
