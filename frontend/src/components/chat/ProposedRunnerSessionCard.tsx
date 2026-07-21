import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type {
  ConfirmRunnerSessionAction,
  ProposedRunnerSession,
  RunnerHarnessId,
} from '@stewra/shared-types';
import { theme } from '../../theme/colors';

interface Props {
  readonly proposal: ProposedRunnerSession;
  /** Invoked when the user taps Start or Cancel; the screen performs the API round-trip. */
  readonly onConfirm: (action: ConfirmRunnerSessionAction) => void;
  /** True while a confirm request for this proposal is in flight (disables the buttons). */
  readonly busy: boolean;
}

/** Human labels for the harness ids. */
const HARNESS_LABELS: Record<RunnerHarnessId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
};

/** A friendly line for each terminal (non-pending) proposal state. */
function terminalMessage(proposal: ProposedRunnerSession): string {
  switch (proposal.status) {
    case 'sent':
      return `Started on ${proposal.deviceName}`;
    case 'cancelled':
      return 'Cancelled — not started';
    case 'failed':
      return proposal.failureReason
        ? `Could not start — ${proposal.failureReason}`
        : 'Could not start right now. Please try again.';
    default:
      return '';
  }
}

/**
 * The in-chat confirmation card for a coding-agent session Stewra proposed running on one of the user's
 * own machines. While `pending` it shows what will run (machine / repo / agent / instruction) with
 * Start / Cancel; once resolved it collapses to a short status line. Purely presentational — the screen
 * owns the API call and re-renders this from the updated message.
 *
 * A `failed` start is transient (e.g. the machine dropped offline for a moment), so it stays actionable:
 * the user can retry (Try again) or discard (Dismiss). Only `sent`/`cancelled` collapse to a terminal
 * status line. This is the mobile twin of the web `ProposedRunnerSessionCard`, and one of two approve
 * surfaces (the other being a natural-language "yes"): Stewra can never start a session itself — tapping
 * Start calls the authenticated, confirm-gated POST /messages/:id/confirm-runner-session.
 */
export const ProposedRunnerSessionCard: React.FC<Props> = React.memo(
  ({ proposal, onConfirm, busy }) => {
    const failed = proposal.status === 'failed';
    const actionable = proposal.status === 'pending' || failed;
    return (
      <View style={styles.card} testID="runner-session-card">
        <Text style={styles.header}>Run coding agent</Text>

        <View style={styles.field}>
          <Text style={styles.label}>Machine</Text>
          <Text style={styles.value}>{proposal.deviceName}</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Repo</Text>
          <Text style={styles.value}>{proposal.workspaceName}</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Agent</Text>
          <Text style={styles.value}>{HARNESS_LABELS[proposal.harness]}</Text>
        </View>
        <Text style={styles.body}>{proposal.prompt}</Text>

        {/* When a start failed, show why above the buttons — then let the user retry or dismiss. */}
        {failed && (
          <Text style={[styles.status, styles.statusFailed, styles.failedReason]}>
            {terminalMessage(proposal)}
          </Text>
        )}

        {actionable ? (
          busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator
                testID="runner-session-busy"
                size="small"
                color={theme.colors.primary}
              />
            </View>
          ) : (
            <View style={styles.actions}>
              <Pressable
                testID="runner-session-cancel"
                accessibilityRole="button"
                onPress={() => onConfirm('cancel')}
                style={({ pressed }) => [
                  styles.button,
                  styles.cancelButton,
                  pressed && styles.cancelPressed,
                ]}
              >
                <Text style={styles.cancelText}>{failed ? 'Dismiss' : 'Cancel'}</Text>
              </Pressable>
              <Pressable
                testID="runner-session-start"
                accessibilityRole="button"
                onPress={() => onConfirm('start')}
                style={({ pressed }) => [
                  styles.button,
                  styles.startButton,
                  pressed && styles.startPressed,
                ]}
              >
                <Text style={styles.startText}>{failed ? 'Try again' : 'Start'}</Text>
              </Pressable>
            </View>
          )
        ) : (
          <Text style={[styles.status, styles.statusDone]} testID="runner-session-status">
            {terminalMessage(proposal)}
          </Text>
        )}
      </View>
    );
  },
);

ProposedRunnerSessionCard.displayName = 'ProposedRunnerSessionCard';

const styles = StyleSheet.create({
  card: {
    marginTop: theme.spacing.sm,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  header: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: theme.spacing.xs,
  },
  field: {
    flexDirection: 'row',
    marginBottom: theme.spacing.xs,
  },
  label: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    width: 64,
  },
  value: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    flex: 1,
    fontWeight: '600',
  },
  body: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  button: {
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    marginLeft: theme.spacing.sm,
  },
  cancelButton: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  cancelPressed: {
    backgroundColor: theme.colors.border,
  },
  cancelText: {
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  startButton: {
    backgroundColor: theme.colors.primary,
  },
  startPressed: {
    backgroundColor: theme.colors.primaryPressed,
  },
  startText: {
    color: theme.colors.onPrimary,
    fontWeight: '700',
  },
  busyRow: {
    alignItems: 'flex-end',
  },
  status: {
    fontSize: 13,
    fontWeight: '600',
  },
  failedReason: {
    marginBottom: theme.spacing.sm,
  },
  statusDone: {
    color: theme.colors.success,
  },
  statusFailed: {
    color: theme.colors.danger,
  },
});
