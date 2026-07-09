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
import type {
  ChatDeliveredEvent,
  ChatReadEvent,
  Message,
  PresenceStatus,
  PresenceUpdateEvent,
  PublicUser,
} from '@stewra/shared-types';
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
import { MessageStatusIndicator } from '../../components/chat/MessageStatusIndicator';
import { TypingIndicator } from '../../components/chat/TypingIndicator';
import { TinyAvatar } from '../../components/chat/TinyAvatar';
import { ReadReceiptManager } from '../../components/chat/ReadReceiptManager';

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

/** "last seen …" for the header of a 1:1 conversation when the peer is offline. */
function lastSeenLabel(lastActiveAt: string): string {
  const then = new Date(lastActiveAt);
  const mins = Math.floor((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${then.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
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
  const [participants, setParticipants] = useState<ReadonlyArray<PublicUser>>([]);
  const [presence, setPresence] = useState<Map<string, { status: PresenceStatus; lastActiveAt: string }>>(
    new Map(),
  );
  const [draft, setDraft] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const [stewraThinking, setStewraThinking] = useState(false);
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'uploading'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [receiptsFor, setReceiptsFor] = useState<Message | null>(null);
  const listRef = useRef<FlatList<Message> | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  /** Insert-or-replace a message by id. The backend echoes our own send back over `chat:message`, and
   *  delivery is at-least-once, so a blind append double-renders the same id. Replacing in place (not
   *  skipping) also lets a re-sent message carry updated fields — status/receipts flips land here. */
  const upsertMessage = useCallback((incoming: Message): void => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === incoming.id);
      if (idx < 0) return [...prev, incoming];
      const next = [...prev];
      next[idx] = incoming;
      return next;
    });
  }, []);

  /** Merge a partial update onto one already-loaded message (delivery/read flips carry no full Message). */
  const patchMessage = useCallback((messageId: string, patch: (msg: Message) => Message): void => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === messageId);
      const existing = prev[idx];
      if (existing === undefined) return prev;
      const next = [...prev];
      next[idx] = patch(existing);
      return next;
    });
  }, []);

  const isStewra = messages.length > 0 && messages[0]?.senderKind === 'assistant';
  const participantsById = useMemo(
    () => new Map(participants.map((p) => [p.id, p])),
    [participants],
  );

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      const res = await api.listMessages(conversationId);
      if (!cancelled) {
        setMessages([...res.messages.items].reverse());
      }
    })();
    // The conversation's other participants power the read-by avatars, the receipt sheet, and presence.
    api
      .getConversation(conversationId)
      .then((res) => {
        if (!cancelled) setParticipants(res.conversation.participants);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Mark the newest message read whenever the tail advances (the pushed screen is visible while mounted).
  // REST mark-read advances the durable watermark AND fans a `chat:message-read` to the room, so senders'
  // ticks flip to read without a separate socket emit.
  useEffect(() => {
    const newest = messages[messages.length - 1];
    if (newest === undefined) return;
    void api.markConversationRead(conversationId, { upToMessageId: newest.id }).catch(() => undefined);
  }, [conversationId, messages]);

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
      // A recipient came online / opened the thread: flip my matching bubble sent→delivered. Never
      // downgrade one already read (read is the terminal state).
      const onDelivered = (event: ChatDeliveredEvent): void => {
        if (event.conversationId !== conversationId) return;
        patchMessage(event.messageId, (msg) =>
          msg.status === 'read'
            ? msg
            : { ...msg, deliveredAt: event.deliveredAt, status: 'delivered' },
        );
      };
      // A recipient read one or more of my messages: attach each receipt and flip that bubble to read.
      const onRead = (event: ChatReadEvent): void => {
        if (event.conversationId !== conversationId) return;
        for (const receipt of event.receipts) {
          patchMessage(receipt.messageId, (msg) => {
            const others = msg.readReceipts.filter((r) => r.userId !== receipt.userId);
            return { ...msg, status: 'read', readReceipts: [...others, receipt] };
          });
        }
      };
      const onPresence = (event: PresenceUpdateEvent): void => {
        setPresence((prev) => {
          const next = new Map(prev);
          next.set(event.userId, { status: event.status, lastActiveAt: event.lastActiveAt });
          return next;
        });
      };

      socket.on(SERVER_EVENTS.CHAT_MESSAGE, onMessage);
      socket.on(SERVER_EVENTS.CHAT_TYPING, onTyping);
      socket.on(SERVER_EVENTS.STEWRA_THINKING, onStewraThinking);
      socket.on(SERVER_EVENTS.STEWRA_REPLY, onStewraReply);
      socket.on(SERVER_EVENTS.STEWRA_ERROR, onStewraError);
      socket.on(SERVER_EVENTS.CHAT_MESSAGE_DELIVERED, onDelivered);
      socket.on(SERVER_EVENTS.CHAT_MESSAGE_READ, onRead);
      socket.on(SERVER_EVENTS.PRESENCE_UPDATE, onPresence);

      return (): void => {
        socket.emit(CLIENT_EVENTS.CHAT_LEAVE, { conversationId });
        socket.off(SERVER_EVENTS.CHAT_MESSAGE, onMessage);
        socket.off(SERVER_EVENTS.CHAT_TYPING, onTyping);
        socket.off(SERVER_EVENTS.STEWRA_THINKING, onStewraThinking);
        socket.off(SERVER_EVENTS.STEWRA_REPLY, onStewraReply);
        socket.off(SERVER_EVENTS.STEWRA_ERROR, onStewraError);
        socket.off(SERVER_EVENTS.CHAT_MESSAGE_DELIVERED, onDelivered);
        socket.off(SERVER_EVENTS.CHAT_MESSAGE_READ, onRead);
        socket.off(SERVER_EVENTS.PRESENCE_UPDATE, onPresence);
      };
    });
    return () => {
      unsubscribed = true;
    };
  }, [conversationId, user?.id, upsertMessage, patchMessage]);

  // Watch the other participants' presence for the header's online / last-seen line.
  useEffect(() => {
    const others = participants.filter((p) => p.id !== user?.id).map((p) => p.id);
    if (others.length === 0) return;
    let unsubscribed = false;
    void connectSocket().then((socket) => {
      if (unsubscribed) return;
      socket.emit(CLIENT_EVENTS.PRESENCE_SUBSCRIBE, { userIds: others }, (res) => {
        if (res.ok) {
          setPresence((prev) => {
            const next = new Map(prev);
            for (const s of res.statuses) {
              next.set(s.userId, { status: s.status, lastActiveAt: s.lastActiveAt });
            }
            return next;
          });
        }
      });
    });
    return () => {
      unsubscribed = true;
    };
  }, [participants, user?.id]);

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

  const renderItem = useCallback(
    ({ item, index }: { item: Message; index: number }): React.JSX.Element => {
      const mine = item.senderId !== null && item.senderId === user?.id;
      const Icon = bubbleIcon(item.type);
      const next = messages[index + 1];
      const isLastInGroup = next === undefined || next.senderId !== item.senderId;
      // The read-by decoration: the readers' small avatars under the last message of a same-sender run,
      // once that message has actually been read (positional, not a separate data concept).
      const readers =
        mine && isLastInGroup && item.status === 'read'
          ? item.readReceipts
              .map((r) => participantsById.get(r.userId))
              .filter((p): p is PublicUser => p !== undefined)
          : [];
      const time = new Date(item.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      return (
        <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
          <Pressable
            onLongPress={mine ? () => setReceiptsFor(item) : undefined}
            style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}
          >
            <View style={styles.bubbleContent}>
              {Icon ? (
                <View style={styles.bubbleIcon}>
                  <Icon size={16} color={theme.colors.textPrimary} />
                </View>
              ) : null}
              <Text style={styles.bubbleText}>{bubbleLabel(item)}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaTime}>{time}</Text>
              {mine ? <MessageStatusIndicator status={item.status} /> : null}
            </View>
          </Pressable>
          {readers.length > 0 ? (
            <View style={styles.readByRow}>
              {readers.map((r) => (
                <TinyAvatar key={r.id} name={r.displayName} avatarUrl={r.avatarUrl} size={16} />
              ))}
            </View>
          ) : null}
        </View>
      );
    },
    [user?.id, messages, participantsById],
  );

  const peer = participants.find((p) => p.id !== user?.id) ?? null;
  const peerPresence = peer ? presence.get(peer.id) : undefined;
  const peerOnline = peerPresence?.status === 'online';

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.header}>
        {!isStewra ? (
          <View style={styles.headerBar}>
            {peer ? (
              <View style={styles.headerIdentity}>
                <TinyAvatar name={peer.displayName} avatarUrl={peer.avatarUrl} size={34} />
                <View style={styles.headerTextGroup}>
                  <Text style={styles.headerTitle} numberOfLines={1}>
                    {peer.displayName}
                  </Text>
                  <View style={styles.presenceRow}>
                    {peerOnline ? (
                      <>
                        <View style={styles.onlineDot} />
                        <Text style={styles.presenceText}>Online</Text>
                      </>
                    ) : (
                      <Text style={styles.presenceText}>
                        {peerPresence ? lastSeenLabel(peerPresence.lastActiveAt) : 'Offline'}
                      </Text>
                    )}
                  </View>
                </View>
              </View>
            ) : (
              <View style={styles.headerTextGroup} />
            )}
            <View style={styles.headerActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Start voice call"
                onPress={() => void handleCall('audio')}
                style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
              >
                <PhoneIcon size={16} color={theme.colors.textPrimary} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Start video call"
                onPress={() => void handleCall('video')}
                style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
              >
                <VideoIcon size={16} color={theme.colors.textPrimary} />
              </Pressable>
            </View>
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
        {peerTyping ? <TypingIndicator /> : null}
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
      <ReadReceiptManager
        message={receiptsFor}
        participants={participants}
        onClose={() => setReceiptsFor(null)}
      />
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
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  headerIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    flex: 1,
    minWidth: 0,
  },
  headerTextGroup: {
    flex: 1,
    minWidth: 0,
  },
  headerTitle: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  presenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  presenceText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.online,
  },
  headerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  headerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 8,
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
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    marginTop: 2,
  },
  metaTime: {
    color: theme.colors.textSecondary,
    fontSize: 10,
  },
  readByRow: {
    flexDirection: 'row',
    gap: 2,
    marginTop: 2,
    marginRight: 2,
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
