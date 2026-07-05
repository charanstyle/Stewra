import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Message } from '@stewra/shared-types';
import { CLIENT_EVENTS, SERVER_EVENTS } from '@stewra/shared-types';
import type { RootStackParamList } from '../../navigation/types';
import { useAuth } from '../../contexts/AuthContext';
import { api, ApiError } from '../../services/api';
import { sendVoiceTurn } from '../../services/stewraVoice';
import { connectSocket, getSocket } from '../../services/socket';
import { callService } from '../../services/call/callService';
import { theme } from '../../theme/colors';
import type { IconProps } from '../../components/icons/Icons';
import { ImageIcon, MicIcon, PhoneIcon, PhoneOffIcon, VideoIcon } from '../../components/icons/Icons';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

function bubbleLabel(message: Message): string {
  switch (message.type) {
    case 'text':
      return message.content ?? '';
    case 'voice':
      return message.transcript ?? 'Voice message';
    case 'audio':
      return 'Voice message';
    case 'image':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'call_start':
      return message.mediaType === 'video' ? 'Video call started' : 'Voice call started';
    case 'call_end': {
      const kind = message.mediaType === 'video' ? 'Video call' : 'Voice call';
      return message.mediaDurationSec != null
        ? `${kind} ended (${message.mediaDurationSec}s)`
        : `${kind} ended`;
    }
    case 'system':
      return message.content ?? 'System message';
    default:
      return message.content ?? '';
  }
}

/** The small leading icon a non-text message bubble shows next to its label, if any. */
function bubbleIcon(type: Message['type']): React.ComponentType<IconProps> | null {
  switch (type) {
    case 'voice':
    case 'audio':
      return MicIcon;
    case 'image':
      return ImageIcon;
    case 'video':
      return VideoIcon;
    case 'call_start':
      return PhoneIcon;
    case 'call_end':
      return PhoneOffIcon;
    default:
      return null;
  }
}

export default function ConversationScreen({ route, navigation }: Props): React.JSX.Element {
  const { conversationId } = route.params;
  const { user } = useAuth();
  const [messages, setMessages] = useState<ReadonlyArray<Message>>([]);
  const [draft, setDraft] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const [stewraThinking, setStewraThinking] = useState(false);
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'uploading'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const listRef = useRef<FlatList<Message> | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  /** Append a message unless one with the same id is already present. The backend echoes our own
   *  send back over `chat:message`, and delivery is at-least-once, so a blind append double-renders
   *  the same id (React "same key" warning). Dedup by id keeps the list a set. */
  const upsertMessage = useCallback((incoming: Message): void => {
    setMessages((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
  }, []);

  const isStewra = messages.length > 0 && messages[0]?.senderKind === 'assistant';

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      const res = await api.listMessages(conversationId);
      if (!cancelled) {
        setMessages([...res.messages.items].reverse());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    let unsubscribed = false;
    void connectSocket().then((socket) => {
      if (unsubscribed) {
        return;
      }
      socket.emit(CLIENT_EVENTS.CHAT_JOIN, { conversationId });

      const onMessage = (event: { message: Message }): void => {
        if (event.message.conversationId !== conversationId) {
          return;
        }
        upsertMessage(event.message);
      };
      const onTyping = (event: { conversationId: string; userId: string; isTyping: boolean }): void => {
        if (event.conversationId !== conversationId || event.userId === user?.id) {
          return;
        }
        setPeerTyping(event.isTyping);
      };
      // Stewra-AI text turns: the assistant reply arrives over `stewra:reply` (not `chat:message`),
      // preceded by a `stewra:thinking` ping and, on model/TTS failure, a `stewra:error`. Without
      // these subscriptions a text reply is generated server-side but never rendered live.
      const onStewraThinking = (event: { conversationId: string }): void => {
        if (event.conversationId !== conversationId) {
          return;
        }
        setStewraThinking(true);
      };
      const onStewraReply = (event: { message: Message }): void => {
        if (event.message.conversationId !== conversationId) {
          return;
        }
        setStewraThinking(false);
        upsertMessage(event.message);
      };
      const onStewraError = (event: { conversationId: string }): void => {
        if (event.conversationId !== conversationId) {
          return;
        }
        setStewraThinking(false);
      };

      socket.on(SERVER_EVENTS.CHAT_MESSAGE, onMessage);
      socket.on(SERVER_EVENTS.CHAT_TYPING, onTyping);
      socket.on(SERVER_EVENTS.STEWRA_THINKING, onStewraThinking);
      socket.on(SERVER_EVENTS.STEWRA_REPLY, onStewraReply);
      socket.on(SERVER_EVENTS.STEWRA_ERROR, onStewraError);

      return (): void => {
        socket.emit(CLIENT_EVENTS.CHAT_LEAVE, { conversationId });
        socket.off(SERVER_EVENTS.CHAT_MESSAGE, onMessage);
        socket.off(SERVER_EVENTS.CHAT_TYPING, onTyping);
        socket.off(SERVER_EVENTS.STEWRA_THINKING, onStewraThinking);
        socket.off(SERVER_EVENTS.STEWRA_REPLY, onStewraReply);
        socket.off(SERVER_EVENTS.STEWRA_ERROR, onStewraError);
      };
    });
    return () => {
      unsubscribed = true;
    };
  }, [conversationId, user?.id, upsertMessage]);

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages.length]);

  const handleChangeDraft = useCallback(
    (text: string): void => {
      setDraft(text);
      const socket = getSocket();
      if (!socket) {
        return;
      }
      socket.emit(CLIENT_EVENTS.CHAT_TYPING, { conversationId, isTyping: text.length > 0 });
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      typingTimeoutRef.current = setTimeout(() => {
        socket.emit(CLIENT_EVENTS.CHAT_TYPING, { conversationId, isTyping: false });
      }, 2000);
    },
    [conversationId],
  );

  const handleSend = async (): Promise<void> => {
    const content = draft.trim();
    if (!content) {
      return;
    }
    setDraft('');
    const res = await api.sendMessage({ conversationId, type: 'text', content });
    upsertMessage(res.message);
  };

  /** Begin a hold-to-talk recording, requesting the mic grant on first use. */
  const handleVoicePressIn = useCallback(async (): Promise<void> => {
    setVoiceError(null);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setVoiceError('Microphone access is required to send a voice message.');
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setVoiceState('recording');
    } catch {
      setVoiceError('Could not start recording.');
      setVoiceState('idle');
    }
  }, [recorder]);

  /** Stop the recording and upload it as a transcribed voice note for this conversation. */
  const handleVoicePressOut = useCallback(async (): Promise<void> => {
    if (voiceState !== 'recording') {
      return;
    }
    setVoiceState('uploading');
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        throw new Error('No recording captured');
      }
      const res = await sendVoiceTurn(conversationId, uri);
      // The server also fans the voice turn out over `chat:message`; upsert dedups by id.
      upsertMessage(res.userMessage);
    } catch (error) {
      setVoiceError(
        error instanceof ApiError ? error.message : 'Could not send your voice message.',
      );
    } finally {
      setVoiceState('idle');
    }
  }, [voiceState, conversationId, recorder, upsertMessage]);

  const handleCall = async (callKind: 'audio' | 'video'): Promise<void> => {
    const others = messages.find((message) => message.senderId && message.senderId !== user?.id);
    const peerId = others?.senderId ?? '';
    try {
      await callService.startOutgoing({
        conversationId,
        callKind,
        peer: { id: peerId, displayName: route.params.title },
      });
      navigation.navigate('Call', {
        conversationId,
        callKind,
        direction: 'outgoing',
        peerName: route.params.title,
      });
    } catch {
      // startOutgoing already tears down state on failure; nothing further to do.
    }
  };

  const renderItem = useMemo(
    () =>
      ({ item }: { item: Message }): React.JSX.Element => {
        const mine = item.senderId !== null && item.senderId === user?.id;
        const Icon = bubbleIcon(item.type);
        return (
          <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
            <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
              <View style={styles.bubbleContent}>
                {Icon ? (
                  <View style={styles.bubbleIcon}>
                    <Icon size={16} color={theme.colors.textPrimary} />
                  </View>
                ) : null}
                <Text style={styles.bubbleText}>{bubbleLabel(item)}</Text>
              </View>
            </View>
          </View>
        );
      },
    [user?.id],
  );

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.header}>
        {!isStewra ? (
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start voice call"
              onPress={() => void handleCall('audio')}
              style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
            >
              <PhoneIcon size={16} color={theme.colors.textPrimary} />
              <Text style={styles.headerButtonLabel}>Voice call</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start video call"
              onPress={() => void handleCall('video')}
              style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
            >
              <VideoIcon size={16} color={theme.colors.textPrimary} />
              <Text style={styles.headerButtonLabel}>Video call</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          removeClippedSubviews
          maxToRenderPerBatch={16}
          windowSize={8}
        />
        {peerTyping ? <Text style={styles.typing}>Typing…</Text> : null}
        {stewraThinking ? <Text style={styles.typing}>Stewra is thinking…</Text> : null}
        {voiceState === 'recording' ? (
          <Text style={styles.typing}>Recording… release to send</Text>
        ) : null}
        {voiceError ? <Text style={styles.voiceError}>{voiceError}</Text> : null}
        <View style={styles.composer}>
          <TextInput
            style={styles.composerInput}
            placeholder="Message"
            placeholderTextColor={theme.colors.textSecondary}
            value={draft}
            onChangeText={handleChangeDraft}
            multiline
          />
          {draft.trim().length > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleSend()}
              style={({ pressed }) => [styles.sendButton, pressed && styles.pressed]}
            >
              <Text style={styles.sendButtonLabel}>Send</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hold to record a voice message"
              disabled={voiceState === 'uploading'}
              onPressIn={() => void handleVoicePressIn()}
              onPressOut={() => void handleVoicePressOut()}
              style={({ pressed }) => [
                styles.micButton,
                (pressed || voiceState === 'recording') && styles.micButtonActive,
                voiceState === 'uploading' && styles.pressed,
              ]}
            >
              {voiceState === 'uploading' ? (
                <ActivityIndicator size="small" color={theme.colors.onPrimary} />
              ) : (
                <MicIcon size={20} color={theme.colors.onPrimary} />
              )}
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  flex: {
    flex: 1,
  },
  header: {
    paddingHorizontal: theme.spacing.md,
  },
  headerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  headerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 6,
  },
  headerButtonLabel: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  listContent: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  bubbleRow: {
    marginBottom: theme.spacing.sm,
    flexDirection: 'row',
  },
  bubbleRowMine: {
    justifyContent: 'flex-end',
  },
  bubbleRowTheirs: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  bubbleMine: {
    backgroundColor: theme.colors.bubbleOutgoing,
  },
  bubbleTheirs: {
    backgroundColor: theme.colors.bubbleIncoming,
  },
  bubbleText: {
    color: theme.colors.textPrimary,
    fontSize: 15,
  },
  bubbleContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bubbleIcon: {
    marginRight: theme.spacing.xs,
  },
  typing: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    paddingHorizontal: theme.spacing.md,
    paddingBottom: 4,
  },
  voiceError: {
    color: theme.colors.danger,
    fontSize: 12,
    paddingHorizontal: theme.spacing.md,
    paddingBottom: 4,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  composerInput: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    color: theme.colors.textPrimary,
    fontSize: 15,
    maxHeight: 120,
  },
  sendButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  micButton: {
    width: 44,
    height: 44,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonActive: {
    backgroundColor: theme.colors.primaryPressed,
  },
  pressed: {
    opacity: 0.7,
  },
  sendButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
});
