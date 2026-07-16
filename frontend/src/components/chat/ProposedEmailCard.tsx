import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ConfirmEmailAction, ProposedEmail } from '@stewra/shared-types';
import { theme } from '../../theme/colors';

interface Props {
  readonly proposal: ProposedEmail;
  /** Invoked when the user taps Send or Cancel; the screen performs the API round-trip. */
  readonly onConfirm: (action: ConfirmEmailAction) => void;
  /** True while a confirm request for this proposal is in flight (disables the buttons). */
  readonly busy: boolean;
}

/** A friendly line for each terminal (non-pending) proposal state. */
function terminalMessage(proposal: ProposedEmail): string {
  switch (proposal.status) {
    case 'sent':
      return `Sent to ${proposal.to}`;
    case 'cancelled':
      return 'Cancelled — not sent';
    case 'failed':
      return proposal.failureReason === 'no_send_account'
        ? 'Could not send — connect a Google account with send permission in Settings.'
        : 'Could not send right now. Please try again.';
    default:
      return '';
  }
}

/**
 * The in-chat confirmation card for an email Stewra drafted. While `pending` it shows the draft
 * (to/subject/body) with Send / Cancel; once resolved it collapses to a short status line. Purely
 * presentational — the screen owns the API call and re-renders this from the updated message.
 *
 * A `failed` send is transient (e.g. a since-reconnected Google grant), so it stays actionable: the
 * user can retry (Try again) or discard (Dismiss). Only `sent`/`cancelled` collapse to a terminal
 * status line. This mirrors the web `ProposedEmailCard`.
 */
export const ProposedEmailCard: React.FC<Props> = React.memo(({ proposal, onConfirm, busy }) => {
  const failed = proposal.status === 'failed';
  const actionable = proposal.status === 'pending' || failed;
  return (
    <View style={styles.card}>
      <Text style={styles.header}>Draft email</Text>

      <View style={styles.field}>
        <Text style={styles.label}>To</Text>
        <Text style={styles.value}>{proposal.to}</Text>
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Subject</Text>
        <Text style={styles.value}>{proposal.subject}</Text>
      </View>
      <Text style={styles.body}>{proposal.body}</Text>

      {/* When a send failed, show why above the buttons — then let the user retry or dismiss. */}
      {failed && (
        <Text style={[styles.status, styles.statusFailed, styles.failedReason]}>
          {terminalMessage(proposal)}
        </Text>
      )}

      {actionable ? (
        busy ? (
          <View style={styles.busyRow}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
          </View>
        ) : (
          <View style={styles.actions}>
            <Pressable
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
              accessibilityRole="button"
              onPress={() => onConfirm('send')}
              style={({ pressed }) => [
                styles.button,
                styles.sendButton,
                pressed && styles.sendPressed,
              ]}
            >
              <Text style={styles.sendText}>{failed ? 'Try again' : 'Send'}</Text>
            </Pressable>
          </View>
        )
      ) : (
        <Text style={[styles.status, styles.statusDone]}>{terminalMessage(proposal)}</Text>
      )}
    </View>
  );
});

ProposedEmailCard.displayName = 'ProposedEmailCard';

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
  sendButton: {
    backgroundColor: theme.colors.primary,
  },
  sendPressed: {
    backgroundColor: theme.colors.primaryPressed,
  },
  sendText: {
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
