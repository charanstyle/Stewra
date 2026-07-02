import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
} from 'expo-audio';
import type { Message } from '@stewra/shared-types';
import { api } from '../../services/api';
import { sendVoiceTurn, resolvePlayableAudio } from '../../services/stewraVoice';
import { theme } from '../../theme/colors';
import { MicIcon } from '../../components/icons/Icons';

type TurnState = 'idle' | 'recording' | 'uploading' | 'playing';

export default function StewraVoiceScreen(): React.JSX.Element {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const player = useAudioPlayer();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [state, setState] = useState<TurnState>('idle');
  const [lastReply, setLastReply] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const permissionRequestedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      if (!permissionRequestedRef.current) {
        permissionRequestedRef.current = true;
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!permission.granted && !cancelled) {
          setError('Microphone access is required to talk to Stewra.');
        }
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      const res = await api.getStewraConversation();
      if (!cancelled) {
        setConversationId(res.conversation.conversation.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePressIn = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      setState('recording');
    } catch {
      setError('Could not start recording.');
    }
  }, [recorder]);

  const handlePressOut = useCallback(async (): Promise<void> => {
    if (state !== 'recording' || !conversationId) {
      return;
    }
    setState('uploading');
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        throw new Error('No recording captured');
      }
      const res = await sendVoiceTurn(conversationId, uri);
      if (res.assistantMessage) {
        setLastReply(res.assistantMessage);
        const playableUri = await resolvePlayableAudio(res.assistantMessage);
        if (playableUri) {
          player.replace({ uri: playableUri });
          setState('playing');
          player.play();
        } else {
          setState('idle');
        }
      } else {
        setState('idle');
      }
    } catch {
      setError('Could not send your message to Stewra.');
      setState('idle');
    }
  }, [state, conversationId, recorder, player]);

  useEffect(() => {
    if (state !== 'playing') {
      return;
    }
    const interval = setInterval(() => {
      if (!player.playing) {
        setState('idle');
      }
    }, 300);
    return () => clearInterval(interval);
  }, [state, player]);

  const label =
    state === 'recording'
      ? 'Release to send'
      : state === 'uploading'
        ? 'Sending…'
        : state === 'playing'
          ? 'Stewra is speaking…'
          : 'Hold to talk';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {lastReply?.transcript || lastReply?.content ? (
          <Text style={styles.transcript}>{lastReply.content ?? lastReply.transcript}</Text>
        ) : (
          <Text style={styles.hint}>Hold the button and speak. Release to hear Stewra reply.</Text>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.buttonWrap}>
          <Pressable
            accessibilityRole="button"
            disabled={state === 'uploading' || state === 'playing' || !conversationId}
            onPressIn={() => void handlePressIn()}
            onPressOut={() => void handlePressOut()}
            style={({ pressed }) => [
              styles.talkButton,
              (pressed || state === 'recording') && styles.talkButtonActive,
              (state === 'uploading' || state === 'playing') && styles.talkButtonDisabled,
            ]}
          >
            {state === 'uploading' ? (
              <ActivityIndicator color={theme.colors.onPrimary} />
            ) : (
              <MicIcon size={36} color={theme.colors.onPrimary} />
            )}
          </Pressable>
          <Text style={styles.stateLabel}>{label}</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  hint: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    marginBottom: theme.spacing.xl,
  },
  transcript: {
    color: theme.colors.textPrimary,
    fontSize: 18,
    textAlign: 'center',
    marginBottom: theme.spacing.xl,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
  },
  buttonWrap: {
    alignItems: 'center',
  },
  talkButton: {
    width: 96,
    height: 96,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  talkButtonActive: {
    backgroundColor: theme.colors.primaryPressed,
  },
  talkButtonDisabled: {
    opacity: 0.6,
  },
  talkButtonLabel: {
    fontSize: 36,
  },
  stateLabel: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    marginTop: theme.spacing.md,
  },
});
