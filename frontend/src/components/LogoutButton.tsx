import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { LogOutIcon } from './icons/Icons';
import { theme } from '../theme/colors';

/**
 * Header "Log out" control for the authenticated tabs. Calls the shared `logout()` — which
 * disconnects the socket, clears the secure-store tokens, and nulls the user so RootNavigator
 * swaps back to the Login stack. Disabled mid-flight so a double-tap can't fire two logouts.
 */
export default function LogoutButton(): React.JSX.Element {
  const { logout } = useAuth();
  const [busy, setBusy] = useState(false);

  const onPress = useCallback(async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await logout();
    } catch {
      // logout() is already best-effort and shouldn't throw, but never let a
      // rejection escape here — an unhandled rejection pops the dev/error overlay
      // on a dev build and is swallowed silently on a release build.
      setBusy(false);
    }
  }, [busy, logout]);

  return (
    <Pressable
      testID="logout-btn"
      onPress={() => void onPress()}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel="Log out"
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.pressed, busy && styles.disabled]}
    >
      <View style={styles.row}>
        <LogOutIcon size={18} color={theme.colors.danger} />
        <Text style={styles.label}>Log out</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    marginRight: theme.spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.danger,
    fontSize: 15,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.5,
  },
});
