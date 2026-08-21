import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { AccountDeletionPreview } from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { theme } from '../../theme/colors';

/**
 * Permanent account deletion, in Settings.
 *
 * Required by Google Play: an app that lets people create an account must let them delete it from
 * inside the app, and must also publish a web page describing how — that page is
 * `website/src/app/legal/AccountDeletionPage.tsx`, and the two must keep saying the same thing.
 *
 * The flow is two steps on purpose, and the first one is the important half. Tapping "Delete
 * account" does not ask "are you sure?" — a confirmation nobody can answer informedly is theatre. It
 * fetches a server-computed preview and shows what the user cannot otherwise see: which
 * organizations will be destroyed along with them because they are the last member, which store
 * subscription will carry on billing them afterwards because only Apple or Google can stop it, and
 * whether anything blocks deletion outright. Only then does it ask for the password.
 *
 * The password is asked for even though the user is already signed in. The person holding an
 * unlocked phone is not necessarily the account's owner, and this is the one action in the app that
 * cannot be undone.
 */
export function DeleteAccountCard(): React.JSX.Element {
  const { logout } = useAuth();
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback((): void => {
    setError(null);
    setLoading(true);
    void api
      .getAccountDeletionPreview()
      .then((res) => setPreview(res.preview))
      .catch((err: unknown) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not check what deleting would remove',
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  const close = useCallback((): void => {
    setPreview(null);
    setPassword('');
    setError(null);
  }, []);

  const confirmDelete = useCallback((): void => {
    setError(null);
    setDeleting(true);
    void api
      .deleteAccount({ password })
      .then(async (res) => {
        // Anything the provider did not confirm is the user's last chance to hear about it — after
        // this they have no account to log back into and ask. Shown as an alert rather than inline
        // because the screen underneath is about to be replaced by the sign-in view.
        const unconfirmed = res.result.revocations.filter((r) => !r.confirmed);
        if (unconfirmed.length > 0) {
          Alert.alert(
            'Account deleted',
            'Your account and its data are gone. We could not confirm these were disconnected, ' +
              'so please check them in that provider’s own security settings:\n\n' +
              unconfirmed.map((r) => `• ${r.target}`).join('\n'),
          );
        }
        setPreview(null);
        setPassword('');
        // Clears the stored tokens and returns to sign-in. The access token stays cryptographically
        // valid until it expires, but there is no longer an account behind it.
        await logout();
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not delete your account'),
      )
      .finally(() => setDeleting(false));
  }, [password, logout]);

  const blocked = preview !== null && preview.blockers.length > 0;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Danger zone</Text>
      {error && preview === null ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.hint}>
        Deleting your account permanently removes your messages, memories, connected accounts and
        files. This cannot be undone.
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={loading}
        onPress={open}
        style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
        testID="settings-delete-account"
      >
        {loading ? (
          <ActivityIndicator color={theme.colors.danger} />
        ) : (
          <Text style={styles.deleteButtonText}>Delete account</Text>
        )}
      </Pressable>

      <Modal visible={preview !== null} animationType="slide" transparent onRequestClose={close}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Delete your account?</Text>
            <Text style={styles.sheetEmail}>{preview?.email ?? ''}</Text>

            {preview?.blockers.map((blocker) => (
              <View key={blocker.orgName} style={styles.blockerBox} testID="delete-blocker">
                <Text style={styles.blockerText}>{blocker.detail}</Text>
              </View>
            ))}

            {preview !== null && preview.orgsToDelete.length > 0 ? (
              <View style={styles.warnBox}>
                <Text style={styles.warnTitle}>These will be deleted with you</Text>
                {preview.orgsToDelete.map((name) => (
                  <Text key={name} style={styles.warnItem}>
                    • {name} — you are its only member, so its customers, campaigns and history go
                    too.
                  </Text>
                ))}
              </View>
            ) : null}

            {preview !== null && preview.storeSubscriptions.length > 0 ? (
              <View style={styles.warnBox}>
                <Text style={styles.warnTitle}>You will still be billed</Text>
                {preview.storeSubscriptions.map((name) => (
                  <Text key={name} style={styles.warnItem}>
                    • {name}
                  </Text>
                ))}
                <Text style={styles.warnItem}>
                  Deleting your account does not cancel a store subscription — only the App Store or
                  Google Play can. Cancel it there first, or you will keep being charged.
                </Text>
              </View>
            ) : null}

            {preview !== null && preview.orgsToLeave.length > 0 ? (
              <Text style={styles.hint}>
                You will be removed from: {preview.orgsToLeave.join(', ')}. Those organizations
                continue without you.
              </Text>
            ) : null}

            {blocked ? null : (
              <>
                <Text style={styles.label}>Enter your password to confirm</Text>
                <TextInput
                  style={styles.input}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Password"
                  placeholderTextColor={theme.colors.textSecondary}
                  testID="delete-account-password"
                />
              </>
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={deleting}
                onPress={close}
                style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}
                testID="delete-account-cancel"
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              {blocked ? null : (
                <Pressable
                  accessibilityRole="button"
                  disabled={deleting || password.length === 0}
                  onPress={confirmDelete}
                  style={({ pressed }) => [
                    styles.confirmButton,
                    (deleting || password.length === 0) && styles.confirmDisabled,
                    pressed && styles.pressed,
                  ]}
                  testID="delete-account-confirm"
                >
                  {deleting ? (
                    <ActivityIndicator color={theme.colors.onPrimary} />
                  ) : (
                    <Text style={styles.confirmText}>Delete forever</Text>
                  )}
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.danger,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    color: theme.colors.danger,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  hint: {
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  deleteButton: {
    marginTop: theme.spacing.xs,
    height: 44,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteButtonText: {
    color: theme.colors.danger,
    fontSize: 15,
    fontWeight: '600',
  },
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: theme.radius.md,
    borderTopRightRadius: theme.radius.md,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  sheetTitle: {
    color: theme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '700',
  },
  sheetEmail: {
    color: theme.colors.textSecondary,
    fontSize: 14,
  },
  blockerBox: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.danger,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
  },
  blockerText: {
    color: theme.colors.danger,
    fontSize: 13,
  },
  warnBox: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    gap: 4,
  },
  warnTitle: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  warnItem: {
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  label: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    marginTop: theme.spacing.xs,
  },
  input: {
    height: 44,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.textPrimary,
    paddingHorizontal: theme.spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  cancelButton: {
    flex: 1,
    height: 44,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  confirmButton: {
    flex: 1,
    height: 44,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmDisabled: {
    opacity: 0.5,
  },
  confirmText: {
    color: theme.colors.onPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 13,
  },
});
