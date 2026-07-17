import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { api, ApiError } from '../../services/api';
import PasswordInput from '../PasswordInput';
import { theme } from '../../theme/colors';

/**
 * The approve-to-send opt-in (experimental), mirroring the web "Your sources" control.
 *
 * TURNING IT ON COSTS A PASSWORD; TURNING IT OFF COSTS NOTHING. That asymmetry is the point: a
 * WhatsApp message is a weaker proof of "it's you" than a signed-in session, so granting this
 * capability re-verifies the account password server-side — a WhatsApp-only attacker can never enable
 * it. Revoking it is frictionless, because making a safety feature hard to switch OFF protects nobody.
 *
 * When the deploy kill-switch is off the server reports `enabled: false` and the control is hidden
 * entirely — the UI must never present a retracted capability as available.
 */
export const EmailOverWhatsappToggle: React.FC = () => {
  const [available, setAvailable] = useState(false);
  const [optedIn, setOptedIn] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getEmailOverWhatsapp()
      .then((res) => {
        if (cancelled) return;
        setAvailable(res.enabled);
        setOptedIn(res.optedIn);
      })
      .catch(() => {
        // Treated as unavailable: if we can't confirm the feature is on, showing a control that
        // claims it is would be a lie. Silent because this is one card on a settings screen.
        if (!cancelled) setAvailable(false);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const closeModal = useCallback((): void => {
    setModalOpen(false);
    setPassword('');
    setError(null);
  }, []);

  const disable = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.setEmailOverWhatsapp({ enabled: false });
      setOptedIn(res.optedIn);
    } catch {
      setError('Could not turn this off. Please try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  const enable = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.setEmailOverWhatsapp({ enabled: true, password });
      setOptedIn(res.optedIn);
      closeModal();
    } catch (err) {
      // The server is the only judge of the password; surface its reason rather than guessing.
      setError(err instanceof ApiError ? err.message : 'Could not turn this on. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [password, closeModal]);

  const handleToggle = useCallback(
    (next: boolean): void => {
      if (next) {
        // Enabling always routes through the password modal — never straight to the API.
        setModalOpen(true);
        return;
      }
      void disable();
    },
    [disable],
  );

  // Not loaded yet, or the kill-switch is off server-side: render nothing at all.
  if (!loaded || !available) {
    return <></>;
  }

  return (
    <View style={styles.section}>
      <View style={styles.titleRow}>
        <Text style={styles.sectionTitle}>Send email by WhatsApp</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>EXPERIMENTAL</Text>
        </View>
      </View>

      <View style={styles.toggleRow}>
        <View style={styles.toggleText}>
          <Text style={styles.toggleHint}>
            With this on, you can ask Stewra to send an email from WhatsApp — but it never sends on its
            own. Stewra drafts it and waits for you to approve. Approving happens in Stewra, or on a
            notification you unlock — never from WhatsApp alone, because a WhatsApp message is a weaker
            proof of “it’s you” than signing in. Turning this on requires your password.
          </Text>
          <Text style={styles.risk}>
            Residual risk: someone with your unlocked phone holding both WhatsApp and a signed-in
            Stewra could approve a send — keep this off if that worries you. Turn it off anytime, no
            password needed.
          </Text>
        </View>
        <Switch
          value={optedIn}
          disabled={busy}
          onValueChange={handleToggle}
          trackColor={{ true: theme.colors.primary, false: theme.colors.border }}
        />
      </View>

      {error !== null && !modalOpen ? <Text style={styles.error}>{error}</Text> : null}

      <Modal visible={modalOpen} transparent animationType="fade" onRequestClose={closeModal}>
        <View style={styles.backdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Confirm your password</Text>
            <Text style={styles.modalBody}>
              Enter your Stewra password to turn on approve-to-send.
            </Text>
            <PasswordInput
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              autoCapitalize="none"
              autoComplete="current-password"
              editable={!busy}
            />
            {error !== null ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={closeModal}
                style={({ pressed }) => [styles.button, styles.cancel, pressed && styles.pressed]}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy || password.length === 0}
                onPress={() => void enable()}
                style={({ pressed }) => [
                  styles.button,
                  styles.confirm,
                  (busy || password.length === 0) && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                ) : (
                  <Text style={styles.confirmText}>Turn on</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  section: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { color: theme.colors.textPrimary, fontSize: 16, fontWeight: '600' },
  badge: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { color: theme.colors.textSecondary, fontSize: 10, fontWeight: '700' },
  toggleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 10 },
  toggleText: { flex: 1, gap: 6 },
  toggleHint: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
  risk: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  error: { color: theme.colors.danger, fontSize: 13, marginTop: 8 },
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'center',
    padding: theme.spacing.lg,
  },
  modal: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: 10,
  },
  modalTitle: { color: theme.colors.textPrimary, fontSize: 17, fontWeight: '600' },
  modalBody: { color: theme.colors.textSecondary, fontSize: 13 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  button: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: theme.radius.sm },
  cancel: { backgroundColor: theme.colors.surfaceAlt },
  cancelText: { color: theme.colors.textSecondary, fontWeight: '600' },
  confirm: { backgroundColor: theme.colors.primary },
  confirmText: { color: theme.colors.textPrimary, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
