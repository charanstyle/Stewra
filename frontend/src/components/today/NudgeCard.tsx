import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Suggestion, SuggestionKind } from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import { theme } from '../../theme/colors';

interface NudgeCardProps {
  readonly suggestion: Suggestion;
  /** Tells the screen this suggestion left the "open" list (snoozed, dismissed, or done). */
  readonly onResolved: (id: string) => void;
  /** Opens the Stewra chat seeded with this nudge (the screen owns navigation). */
  readonly onChatOpened: (conversationId: string) => void;
}

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

const KIND_LABEL: Readonly<Record<SuggestionKind, string>> = {
  needs_reply: 'Needs a reply',
  important_unread: 'Important, unread',
  follow_up: 'Waiting on a reply',
  calendar_prep: 'Calendar prep',
  other: 'Worth a look',
};

/** 9am local time tomorrow, as the ISO string the snooze API expects (same rule as the website). */
function tomorrowAt9AM(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/**
 * One proactive nudge, the mobile mirror of the website's NudgeCard: collapsed to kind, title, and
 * rationale; expands into the decision row — Draft a reply (read-only text, never a send), Chat
 * (deep-link into the Stewra conversation), Snooze / Done / Dismiss. Reply-drafting stays read-only:
 * Stewra prepares text for review, the user sends from their own mail surface.
 */
export function NudgeCard({ suggestion, onResolved, onChatOpened }: NudgeCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const hasReplyOption = suggestion.options.some((o) => o.action.type === 'reply_email');

  const requestDraft = useCallback((): void => {
    void run(async () => {
      const res = await api.requestDraft(suggestion.id, {});
      setDraft(res.draft);
    });
  }, [suggestion.id, run]);

  const chatAboutThis = useCallback((): void => {
    void run(async () => {
      const res = await api.chatAboutSuggestion(suggestion.id, {});
      onChatOpened(res.conversationId);
    });
  }, [suggestion.id, onChatOpened, run]);

  const snooze = useCallback((): void => {
    void run(async () => {
      await api.snoozeSuggestion(suggestion.id, { until: tomorrowAt9AM() });
      onResolved(suggestion.id);
    });
  }, [suggestion.id, onResolved, run]);

  const dismiss = useCallback((): void => {
    void run(async () => {
      await api.dismissSuggestion(suggestion.id);
      onResolved(suggestion.id);
    });
  }, [suggestion.id, onResolved, run]);

  const markDone = useCallback((): void => {
    void run(async () => {
      await api.markSuggestionDone(suggestion.id);
      onResolved(suggestion.id);
    });
  }, [suggestion.id, onResolved, run]);

  return (
    <View style={styles.card} testID="today-nudge">
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded((prev) => !prev)}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <Text style={styles.kindLabel}>{KIND_LABEL[suggestion.kind]}</Text>
        <Text style={styles.title}>{suggestion.title}</Text>
        <Text style={styles.rationale}>{suggestion.rationale}</Text>
      </Pressable>

      {expanded ? (
        <View style={styles.body}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {busy ? <ActivityIndicator color={theme.colors.primary} /> : null}
          {draft !== null ? (
            <View style={styles.draftBox}>
              <Text style={styles.draftLabel}>Draft (for your review — nothing is sent)</Text>
              <Text style={styles.draftText}>{draft}</Text>
            </View>
          ) : null}
          <View style={styles.actions}>
            {hasReplyOption && draft === null ? (
              <ActionButton label="Draft a reply" disabled={busy} onPress={requestDraft} />
            ) : null}
            <ActionButton label="Chat" disabled={busy} onPress={chatAboutThis} />
            <ActionButton label="Snooze" disabled={busy} onPress={snooze} />
            <ActionButton label="Done" disabled={busy} onPress={markDone} />
            <ActionButton label="Dismiss" disabled={busy} onPress={dismiss} muted />
          </View>
        </View>
      ) : null}
    </View>
  );
}

interface ActionButtonProps {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly muted?: boolean;
}

function ActionButton({ label, disabled, onPress, muted = false }: ActionButtonProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
    >
      <Text style={muted ? styles.actionTextMuted : styles.actionText}>{label}</Text>
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
  },
  header: {
    gap: 2,
  },
  pressed: {
    opacity: 0.7,
  },
  kindLabel: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  rationale: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  body: {
    marginTop: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  draftBox: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.sm,
  },
  draftLabel: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    marginBottom: 4,
  },
  draftText: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  actionButton: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.pill,
    paddingVertical: 6,
    paddingHorizontal: theme.spacing.md,
  },
  actionText: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  actionTextMuted: {
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 13,
  },
});
