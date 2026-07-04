import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RTCView, type MediaStream } from '@livekit/react-native-webrtc';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { callService } from '../../services/call/callService';
import type { CallStatus } from '../../services/call/callService';
import { theme } from '../../theme/colors';
import { MicIcon, MicOffIcon, PhoneOffIcon, SpeakerIcon, VideoIcon, VideoOffIcon } from '../../components/icons/Icons';

type Props = NativeStackScreenProps<RootStackParamList, 'Call'>;

const STATUS_LABEL: { readonly [K in CallStatus]: string } = {
  idle: '',
  outgoing: 'Calling…',
  incoming: 'Incoming call…',
  connecting: 'Connecting…',
  active: 'Connected',
  ended: 'Call ended',
};

export default function CallScreen({ route, navigation }: Props): React.JSX.Element {
  const { callKind, peerName, direction, conversationId } = route.params;
  const [status, setStatus] = useState<CallStatus>(callService.getStatus());
  const [localStream, setLocalStream] = useState<MediaStream | null>(callService.getLocalStream());
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(callService.getRemoteStream());
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(callKind === 'video');
  const [speakerOn, setSpeakerOn] = useState(callKind === 'video');
  const startedOutgoing = useRef(false);

  useEffect(() => {
    if (direction === 'outgoing') {
      startedOutgoing.current = true;
    }
  }, [direction]);

  useEffect(() => {
    const offStatus = callService.on('status', setStatus);
    const offLocal = callService.on('localStream', setLocalStream);
    const offRemote = callService.on('remoteStream', setRemoteStream);
    const offEnded = callService.on('ended', () => {
      if (navigation.canGoBack()) {
        navigation.goBack();
      }
    });
    return () => {
      offStatus();
      offLocal();
      offRemote();
      offEnded();
    };
  }, [navigation]);

  const handleHangup = (): void => {
    if (status === 'incoming') {
      callService.declineIncoming('declined');
    } else {
      callService.hangup('hangup');
    }
  };

  const toggleAudio = (): void => {
    setAudioEnabled(callService.toggleAudio(!audioEnabled));
  };

  const toggleVideo = (): void => {
    setVideoEnabled(callService.toggleVideo(!videoEnabled));
  };

  const toggleSpeaker = (): void => {
    const next = !speakerOn;
    callService.setSpeaker(next);
    setSpeakerOn(next);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.streams}>
        {remoteStream && callKind === 'video' ? (
          <RTCView streamURL={remoteStream.toURL()} style={styles.remoteVideo} objectFit="cover" />
        ) : (
          <View style={styles.avatarWrap}>
            <View style={styles.avatar}>
              <Text style={styles.avatarInitial}>{peerName.charAt(0).toUpperCase()}</Text>
            </View>
            <Text style={styles.peerName}>{peerName}</Text>
            <Text style={styles.statusLabel}>{STATUS_LABEL[status]}</Text>
          </View>
        )}

        {localStream && callKind === 'video' && videoEnabled ? (
          <RTCView streamURL={localStream.toURL()} style={styles.localVideo} objectFit="cover" mirror />
        ) : null}
      </View>

      <View style={styles.controls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
          onPress={toggleAudio}
          style={({ pressed }) => [styles.controlButton, !audioEnabled && styles.controlButtonOff, pressed && styles.pressed]}
        >
          {audioEnabled ? (
            <MicIcon size={24} color={theme.colors.textPrimary} />
          ) : (
            <MicOffIcon size={24} color={theme.colors.onPrimary} />
          )}
          <Text style={styles.controlLabel}>{audioEnabled ? 'Mute' : 'Unmute'}</Text>
        </Pressable>

        {callKind === 'video' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={videoEnabled ? 'Stop video' : 'Start video'}
            onPress={toggleVideo}
            style={({ pressed }) => [
              styles.controlButton,
              !videoEnabled && styles.controlButtonOff,
              pressed && styles.pressed,
            ]}
          >
            {videoEnabled ? (
              <VideoIcon size={24} color={theme.colors.textPrimary} />
            ) : (
              <VideoOffIcon size={24} color={theme.colors.onPrimary} />
            )}
            <Text style={styles.controlLabel}>{videoEnabled ? 'Stop video' : 'Start video'}</Text>
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={speakerOn ? 'Turn speaker off' : 'Turn speaker on'}
          onPress={toggleSpeaker}
          style={({ pressed }) => [
            styles.controlButton,
            speakerOn && styles.controlButtonOn,
            pressed && styles.pressed,
          ]}
        >
          <SpeakerIcon size={24} color={speakerOn ? theme.colors.onPrimary : theme.colors.textPrimary} />
          <Text style={styles.controlLabel}>Speaker</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End call"
          onPress={handleHangup}
          style={({ pressed }) => [styles.hangupButton, pressed && styles.pressed]}
        >
          <PhoneOffIcon size={28} color={theme.colors.onPrimary} />
        </Pressable>
      </View>

      {/* conversationId flows through for the caller's own reference during signaling; nothing to render. */}
      <Text style={styles.hidden}>{conversationId}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  streams: {
    flex: 1,
  },
  remoteVideo: {
    flex: 1,
  },
  localVideo: {
    position: 'absolute',
    top: theme.spacing.lg,
    right: theme.spacing.lg,
    width: 110,
    height: 150,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  avatarWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    width: 120,
    height: 120,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.lg,
  },
  avatarInitial: {
    color: theme.colors.onPrimary,
    fontSize: 48,
    fontWeight: '600',
  },
  peerName: {
    color: theme.colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
  },
  statusLabel: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    marginTop: theme.spacing.xs,
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    paddingVertical: theme.spacing.lg,
    paddingHorizontal: theme.spacing.md,
  },
  controlButton: {
    width: 60,
    height: 60,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlButtonOn: {
    backgroundColor: theme.colors.primary,
  },
  controlButtonOff: {
    backgroundColor: theme.colors.danger,
  },
  pressed: {
    opacity: 0.75,
  },
  controlLabel: {
    color: theme.colors.textPrimary,
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
  },
  hangupButton: {
    width: 72,
    height: 72,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hangupLabel: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  hidden: {
    height: 0,
    width: 0,
    overflow: 'hidden',
  },
});
