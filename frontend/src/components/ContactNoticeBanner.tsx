import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ContactNotice } from '../contexts/ContactsContext';
import { api } from '../services/api';
import { navigationRef } from '../navigation/RootNavigator';
import { theme } from '../theme/colors';

const VISIBLE_MS = 5000;

interface Props {
  readonly notice: ContactNotice | null;
  readonly onDismiss: () => void;
}

/**
 * A transient top banner for contact events (invite received / accepted). It slides in whenever a new
 * `notice` arrives, auto-dismisses after a few seconds, and — when the notice carries a contact — is
 * tappable to jump straight into a direct conversation with them ("say hi"). Rendered once, globally,
 * above the navigator so it appears on any screen.
 */
export function ContactNoticeBanner({ notice, onDismiss }: Props): React.JSX.Element | null {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(-120)).current;

  useEffect(() => {
    if (!notice) {
      return;
    }
    translateY.setValue(-120);
    Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
    const timer = setTimeout(onDismiss, VISIBLE_MS);
    return () => clearTimeout(timer);
    // Re-run for every distinct notice (key changes even when text repeats).
  }, [notice?.key, notice, onDismiss, translateY]);

  if (!notice) {
    return null;
  }

  const openConversation = async (): Promise<void> => {
    const contact = notice.contact;
    onDismiss();
    if (!contact || !navigationRef.isReady()) {
      return;
    }
    const res = await api.createConversation({
      type: 'direct',
      participantUserIds: [contact.user.id],
    });
    navigationRef.navigate('Conversation', {
      conversationId: res.conversation.id,
      title: contact.user.displayName,
    });
  };

  return (
    <Animated.View
      style={[styles.container, { top: insets.top + theme.spacing.sm, transform: [{ translateY }] }]}
      pointerEvents="box-none"
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => void openConversation()}
        style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
      >
        <Text style={styles.text}>{notice.text}</Text>
        {notice.contact ? <Text style={styles.action}>Tap to open chat</Text> : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: theme.spacing.md,
    right: theme.spacing.md,
    zIndex: 1000,
    elevation: 12,
  },
  banner: {
    backgroundColor: theme.colors.success,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    shadowColor: theme.colors.shadow,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  pressed: {
    opacity: 0.85,
  },
  text: {
    color: theme.colors.onPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  action: {
    color: theme.colors.onPrimary,
    fontSize: 12,
    marginTop: 2,
    opacity: 0.9,
  },
});
