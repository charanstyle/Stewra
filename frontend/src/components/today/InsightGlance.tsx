import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, ApiError } from '../../services/api';
import { theme } from '../../theme/colors';

/**
 * On-demand insight glances — the mobile mirror of the website ActivityPage's insight panel. Two
 * buttons ask the agent for a calendar or inbox glance; the summary renders with a dismiss control.
 * The impression beacon (`markInsightSeen`) fires when a summary appears; dismissing clears locally
 * first and reports the implicit-negative signal in the background, exactly like the web.
 */
export function InsightGlance(): React.JSX.Element {
  const [busyKind, setBusyKind] = useState<'calendar' | 'gmail' | null>(null);
  const [insightId, setInsightId] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (insightId === null) {
      return;
    }
    // Impression beacon — first-write-wins server-side; a failure is not the user's problem.
    void api.markInsightSeen(insightId).catch(() => undefined);
  }, [insightId]);

  const generate = useCallback((kind: 'calendar' | 'gmail'): void => {
    setError(null);
    setBusyKind(kind);
    void api
      .generateInsight({ kind })
      .then((res) => {
        setSummary(res.insight.summary);
        setInsightId(res.insightId);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      })
      .finally(() => setBusyKind(null));
  }, []);

  const dismiss = useCallback((): void => {
    const id = insightId;
    setSummary(null);
    setInsightId(null);
    if (id !== null) {
      void api.markInsightDismissed(id).catch(() => undefined);
    }
  }, [insightId]);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Ask Stewra for a glance</Text>
      <View style={styles.buttonRow}>
        <GlanceButton
          label="Calendar"
          busy={busyKind === 'calendar'}
          disabled={busyKind !== null}
          onPress={() => generate('calendar')}
        />
        <GlanceButton
          label="Inbox"
          busy={busyKind === 'gmail'}
          disabled={busyKind !== null}
          onPress={() => generate('gmail')}
        />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {summary !== null ? (
        <View style={styles.insightBox} testID="today-insight">
          <Text style={styles.insightText}>{summary}</Text>
          <Pressable accessibilityRole="button" onPress={dismiss} style={({ pressed }) => pressed && styles.pressed}>
            <Text style={styles.dismissText}>Dismiss</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

interface GlanceButtonProps {
  readonly label: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

function GlanceButton({ label, busy, disabled, onPress }: GlanceButtonProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.glanceButton, pressed && styles.pressed]}
    >
      {busy ? (
        <ActivityIndicator color={theme.colors.primary} />
      ) : (
        <Text style={styles.glanceText}>{label}</Text>
      )}
    </Pressable>
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
  sectionTitle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  glanceButton: {
    flex: 1,
    height: 40,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glanceText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
  insightBox: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  insightText: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  dismissText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 13,
  },
});
