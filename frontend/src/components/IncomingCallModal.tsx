import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { IncomingCallInfo } from '../services/call/callService';
import { theme } from '../theme/colors';
import { PhoneIcon, PhoneOffIcon } from './icons/Icons';

interface IncomingCallModalProps {
  readonly info: IncomingCallInfo;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}

export default function IncomingCallModal({
  info,
  onAccept,
  onDecline,
}: IncomingCallModalProps): React.JSX.Element {
  return (
    <Modal visible animationType="slide" transparent statusBarTranslucent>
      <View style={styles.overlay}>
        <SafeAreaView style={styles.sheet}>
          <View style={styles.avatar}>
            <Text style={styles.avatarInitial}>{info.peer.displayName.charAt(0).toUpperCase()}</Text>
          </View>
          <Text style={styles.name}>{info.peer.displayName}</Text>
          <Text style={styles.subtitle}>
            Incoming {info.callKind === 'video' ? 'video' : 'voice'} call
          </Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Decline call"
              onPress={onDecline}
              style={({ pressed }) => [
                styles.actionButton,
                styles.declineButton,
                pressed && styles.pressed,
              ]}
            >
              <PhoneOffIcon size={22} color={theme.colors.onPrimary} />
              <Text style={styles.actionLabel}>Decline</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Accept call"
              onPress={onAccept}
              style={({ pressed }) => [styles.actionButton, styles.acceptButton, pressed && styles.pressed]}
            >
              <PhoneIcon size={22} color={theme.colors.onPrimary} />
              <Text style={styles.actionLabel}>Accept</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    alignItems: 'center',
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.md,
  },
  avatarInitial: {
    color: theme.colors.onPrimary,
    fontSize: 36,
    fontWeight: '600',
  },
  name: {
    color: theme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
  },
  subtitle: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xl,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    gap: theme.spacing.md,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    alignItems: 'center',
  },
  declineButton: {
    backgroundColor: theme.colors.danger,
  },
  acceptButton: {
    backgroundColor: theme.colors.success,
  },
  pressed: {
    opacity: 0.8,
  },
  actionLabel: {
    color: theme.colors.onPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
});
