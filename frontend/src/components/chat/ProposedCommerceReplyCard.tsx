import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ConfirmCommerceReplyAction, ProposedCommerceReply } from '@stewra/shared-types';
import { theme } from '../../theme/colors';

interface Props {
  readonly proposal: ProposedCommerceReply;
  /** Invoked when the user taps Send or Cancel; the screen performs the API round-trip. */
  readonly onConfirm: (action: ConfirmCommerceReplyAction) => void;
  /** True while a confirm request for this proposal is in flight (hides the buttons). */
  readonly busy: boolean;
}

/** A friendly line for each terminal (non-pending) proposal state. */
function terminalMessage(proposal: ProposedCommerceReply): string {
  switch (proposal.status) {
    case 'sent':
      return `Sent to ${proposal.contactName}`;
    case 'cancelled':
      return 'Cancelled — not sent';
    case 'failed':
      return proposal.failureReason
        ? `Could not send — ${proposal.failureReason}`
        : 'Could not send right now. Please try again.';
    default:
      return '';
  }
}

/**
 * The in-chat confirmation card for a reply Stewra proposed to one of an organization's CUSTOMERS.
 *
 * The recipient is the reason this card exists and the reason it shows the whole message body rather
 * than a summary: they are a member of the public who never spoke to Stewra, the message will arrive
 * under the business's name, and a delivered WhatsApp message cannot be recalled. So the user reads
 * exactly what will be sent, to exactly whom, from exactly which business, before anything happens.
 *
 * Purely presentational — the screen owns the API call and re-renders this from the updated message.
 * The mobile twin of the web card, and one of two approve surfaces (the other being a
 * natural-language "yes" in chat): Stewra can never send this itself. Tapping Send calls the
 * authenticated POST /messages/:id/confirm-commerce-reply, which runs the SAME executor the "yes"
 * path does.
 */
export const ProposedCommerceReplyCard: React.FC<Props> = React.memo(
  ({ proposal, onConfirm, busy }) => {
    // A `failed` send is usually transient (a network blip, a token that needs refreshing), so it stays
    // actionable rather than forcing the user to retype the reply. Only `sent`/`cancelled` collapse to
    // a status line — `sent` because the customer already has it and there is no undo.
    const failed = proposal.status === 'failed';
    const actionable = proposal.status === 'pending' || failed;

    return (
      <View style={styles.card} testID="commerce-reply-card">
        <Text style={styles.header}>Reply to customer</Text>

        <View style={styles.field}>
          <Text style={styles.label}>To</Text>
          <Text style={styles.value}>{proposal.contactName}</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>From</Text>
          <Text style={styles.value}>{proposal.orgName}</Text>
        </View>
        <Text style={styles.body}>{proposal.body}</Text>

        {/* When a send failed, show why above the buttons — then let the user retry or dismiss. */}
        {failed ? (
          <Text style={[styles.status, styles.statusFailed, styles.failedReason]}>
            {terminalMessage(proposal)}
          </Text>
        ) : null}

        {actionable ? (
          busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator
                testID="commerce-reply-busy"
                size="small"
                color={theme.colors.primary}
              />
            </View>
          ) : (
            <View style={styles.actions}>
              <Pressable
                testID="commerce-reply-cancel"
                accessibilityRole="button"
                accessibilityLabel={failed ? 'Dismiss reply' : 'Cancel reply'}
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
                testID="commerce-reply-send"
                accessibilityRole="button"
                accessibilityLabel={failed ? 'Try sending again' : 'Send reply to customer'}
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
          <Text style={[styles.status, styles.statusDone]} testID="commerce-reply-status">
            {terminalMessage(proposal)}
          </Text>
        )}
      </View>
    );
  },
);

ProposedCommerceReplyCard.displayName = 'ProposedCommerceReplyCard';

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
    width: 48,
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
