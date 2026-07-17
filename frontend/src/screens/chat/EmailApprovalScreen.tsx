import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ConfirmEmailAction, Message } from '@stewra/shared-types';
import type { RootStackParamList } from '../../navigation/types';
import { ProposedEmailCard } from '../../components/chat/ProposedEmailCard';
import { api } from '../../services/api';
import { confirmDeviceOwner } from '../../services/biometrics';
import { theme } from '../../theme/colors';

type Props = NativeStackScreenProps<RootStackParamList, 'EmailApproval'>;

/**
 * The approve-to-send gate, opened by tapping Approve on the email-approval notification.
 *
 * WHY A SCREEN AND NOT A NOTIFICATION BUTTON. Android cannot gate a notification action behind
 * biometrics — an action either runs in the background or opens the app. Opening the app is therefore
 * the ONLY way to make Approve prove it's you, and it is why this screen exists at all.
 *
 * THE DRAFT IS FETCHED, NOT CARRIED. The notification holds only a `messageId`; the email itself is
 * loaded here over the authenticated session. That keeps the recipient, subject, and body out of the
 * OS notification (and off the lock screen), and it means the user approves something they can read
 * rather than a blind "Approve email?".
 *
 * The send itself is the same authenticated `POST /messages/:id/confirm-email` the in-app Send button
 * uses. Nothing on this path grants WhatsApp any authority to send.
 */
export default function EmailApprovalScreen({ route, navigation }: Props): React.JSX.Element {
  const { messageId } = route.params;
  const [message, setMessage] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getMessage(messageId)
      .then((res) => {
        if (!cancelled) setMessage(res.message);
      })
      .catch(() => {
        // Loud rather than a blank screen: the user tapped Approve and deserves to know it didn't load.
        if (!cancelled) setError("Couldn't load this draft. Open the chat in Stewra to review it.");
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  const handleConfirm = useCallback(
    async (action: ConfirmEmailAction): Promise<void> => {
      setNotice(null);
      // Cancelling is NOT gated. It only ever discards a draft — it removes a capability rather than
      // exercising one — so demanding a fingerprint to say "no" would add friction to the safe choice.
      if (action === 'send') {
        const check = await confirmDeviceOwner('Confirm it’s you to send this email');
        if (check === 'failed') {
          setNotice('Not confirmed — the email was not sent.');
          return;
        }
        // `unavailable` means the device has no biometric or passcode at all. There is no stronger
        // factor to ask for, so this falls back to exactly what the in-app Send button already
        // guarantees: an open, signed-in app. Proceeding is the honest behaviour; pretending we
        // verified an owner we could not verify would not be.
      }

      setBusy(true);
      try {
        const res = await api.confirmEmail(messageId, { action });
        setMessage(res.message);
        // The card now renders its own terminal state (Sent / Cancelled), so leave the user on it
        // briefly rather than yanking the screen away before they can see what happened.
      } catch {
        setNotice('That didn’t go through. You can try again, or open the chat in Stewra.');
      } finally {
        setBusy(false);
      }
    },
    [messageId],
  );

  const proposal = message?.proposedEmail ?? null;
  const resolved = proposal !== null && proposal.status !== 'pending' && proposal.status !== 'failed';

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.content}>
        {error !== null ? (
          <Text style={styles.error}>{error}</Text>
        ) : message === null ? (
          <ActivityIndicator size="large" color={theme.colors.primary} />
        ) : proposal === null ? (
          <Text style={styles.error}>This message has no email to approve.</Text>
        ) : (
          <>
            <Text style={styles.title}>Approve this email?</Text>
            <Text style={styles.subtitle}>
              Stewra drafted this from your WhatsApp message. It hasn&apos;t been sent.
            </Text>
            <ProposedEmailCard proposal={proposal} busy={busy} onConfirm={(a) => void handleConfirm(a)} />
            {notice !== null ? <Text style={styles.notice}>{notice}</Text> : null}
            {resolved ? (
              <Text style={styles.done} onPress={() => navigation.goBack()}>
                Done
              </Text>
            ) : null}
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { flex: 1, justifyContent: 'center', padding: 20, gap: 12 },
  title: { color: theme.colors.textPrimary, fontSize: 22, fontWeight: '600' },
  subtitle: { color: theme.colors.textSecondary, fontSize: 14 },
  error: { color: theme.colors.textSecondary, fontSize: 15, textAlign: 'center' },
  notice: { color: theme.colors.danger, fontSize: 14, textAlign: 'center' },
  done: {
    color: theme.colors.primary,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 12,
  },
});
