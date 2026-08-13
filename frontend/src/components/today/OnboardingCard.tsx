import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, ApiError } from '../../services/api';
import { theme } from '../../theme/colors';

interface OnboardingCardProps {
  /** Whether the user already holds at least one connection (step 2: value now, not at next tick). */
  readonly hasConnection: boolean;
  /** Runs the server-side recompute; the screen owns the state it refreshes. */
  readonly onBuildFirstBriefing: () => void;
  readonly building: boolean;
}

/**
 * The cold-start onboarding on the Today tab (build-plan M5): be valuable with just the calendar,
 * earn the next connection. Step 1 (no connections) explains what Stewra does in plain words and
 * offers exactly one action — Connect Google Calendar, with the SERVER's consent prompt shown before
 * the browser opens, so every client asks with the same sentence. Step 2 (connected, no briefing
 * yet) builds the first briefing on demand instead of making the user wait for the next tick.
 */
export function OnboardingCard({
  hasConnection,
  onBuildFirstBriefing,
  building,
}: OnboardingCardProps): React.JSX.Element {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectGoogle = useCallback((): void => {
    setError(null);
    setConnecting(true);
    void api
      .startGoogleConnection()
      .then((res) =>
        new Promise<void>((resolve) => {
          Alert.alert('Connect Google', res.consentPrompt, [
            { text: 'Not now', style: 'cancel', onPress: () => resolve() },
            {
              text: 'Continue',
              onPress: () => {
                void Linking.openURL(res.authorizeUrl).catch(() =>
                  setError('Could not open the browser'),
                );
                resolve();
              },
            },
          ]);
        }),
      )
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not start the connection'),
      )
      .finally(() => setConnecting(false));
  }, []);

  if (hasConnection) {
    return (
      <View style={styles.card} testID="today-onboarding">
        <Text style={styles.title}>You’re connected</Text>
        <Text style={styles.body}>
          Stewra will refresh this on its own from here — but there’s no reason to wait for the
          first one.
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={building}
          onPress={onBuildFirstBriefing}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          {building ? (
            <ActivityIndicator color={theme.colors.primary} />
          ) : (
            <Text style={styles.buttonText}>Build my first briefing</Text>
          )}
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.card} testID="today-onboarding">
      <Text style={styles.title}>Let’s get you a reason to come back tomorrow</Text>
      <Text style={styles.body}>
        Stewra works from sources you explicitly connect — nothing else. Start with just your Google
        calendar: that alone is enough for a daily look at your week and conflicts worth knowing
        about.
      </Text>
      <Text style={styles.bullet}>• Read-only to start — Stewra never acts without your yes.</Text>
      <Text style={styles.bullet}>• Every read lands in your Activity feed.</Text>
      <Text style={styles.bullet}>
        • One switch pauses everything; disconnecting revokes access at Google itself.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={connecting}
        onPress={connectGoogle}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        testID="onboarding-connect-google"
      >
        {connecting ? (
          <ActivityIndicator color={theme.colors.primary} />
        ) : (
          <Text style={styles.buttonText}>Connect Google Calendar</Text>
        )}
      </Pressable>
      <Text style={styles.footnote}>
        Gmail, banking, and WhatsApp can come later, one at a time, if Stewra earns them.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  body: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  bullet: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  button: {
    marginTop: theme.spacing.xs,
    height: 44,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: theme.colors.onPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.8,
  },
  footnote: {
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 13,
  },
});
