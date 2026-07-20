import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardHeight } from '../../hooks/useKeyboardHeight';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  PASSWORD_RESET_CODE_LENGTH,
  PASSWORD_RESET_MIN_PASSWORD_LENGTH,
} from '@stewra/shared-types';
import type { RootStackParamList } from '../../navigation/types';
import { api, ApiError } from '../../services/api';
import { theme } from '../../theme/colors';
import PasswordInput from '../../components/PasswordInput';

type Props = NativeStackScreenProps<RootStackParamList, 'ResetPassword'>;

export default function ResetPasswordScreen({ navigation, route }: Props): React.JSX.Element {
  const { email } = route.params;
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();

  const passwordsMatch = password === confirmPassword;
  const showMismatch = confirmPassword.length > 0 && !passwordsMatch;
  const canSubmit =
    code.length === PASSWORD_RESET_CODE_LENGTH &&
    password.length >= PASSWORD_RESET_MIN_PASSWORD_LENGTH &&
    passwordsMatch;

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      await api.confirmPasswordReset({ email, code, newPassword: password });
      // Reset succeeded — send them back to sign in with the new password.
      navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset your password. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    setResending(true);
    try {
      await api.requestPasswordReset({ email });
      setInfo('If that email has an account, a new code is on its way.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not resend the code.');
    } finally {
      setResending(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Manual keyboard avoidance — KeyboardAvoidingView is a no-op on Android under Expo
          edge-to-edge (see useKeyboardHeight). */}
      <View style={[styles.flex, { paddingBottom: Math.max(keyboardHeight - insets.bottom, 0) }]}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Enter your code</Text>
          <Text style={styles.subtitle}>
            We sent a {PASSWORD_RESET_CODE_LENGTH}-digit code to {email}. Enter it below with your new
            password.
          </Text>

          <TextInput
            style={styles.codeInput}
            placeholder="000000"
            placeholderTextColor={theme.colors.textSecondary}
            keyboardType="number-pad"
            maxLength={PASSWORD_RESET_CODE_LENGTH}
            value={code}
            onChangeText={setCode}
          />
          <PasswordInput
            placeholder="New password (min. 8 characters)"
            autoComplete="password-new"
            value={password}
            onChangeText={setPassword}
          />
          <PasswordInput
            placeholder="Confirm new password"
            autoComplete="password-new"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
          />

          {showMismatch ? <Text style={styles.error}>Passwords don&apos;t match</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {info ? <Text style={styles.info}>{info}</Text> : null}

          <Pressable
            accessibilityRole="button"
            disabled={submitting || !canSubmit}
            onPress={() => void handleSubmit()}
            style={({ pressed }) => [
              styles.primaryButton,
              (pressed || submitting) && styles.pressed,
              !canSubmit && styles.disabled,
            ]}
          >
            {submitting ? (
              <ActivityIndicator color={theme.colors.onPrimary} />
            ) : (
              <Text style={styles.primaryButtonLabel}>Reset password</Text>
            )}
          </Pressable>

          <Pressable disabled={resending} onPress={() => void handleResend()} style={styles.linkButton}>
            <Text style={styles.linkText}>{resending ? 'Sending…' : 'Resend code'}</Text>
          </Pressable>

          <Pressable onPress={() => navigation.navigate('Login')} style={styles.linkButton}>
            <Text style={styles.linkText}>Back to sign in</Text>
          </Pressable>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  flex: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xl,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xl,
  },
  codeInput: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.md,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.md,
    fontSize: 28,
    letterSpacing: 8,
    textAlign: 'center',
  },
  error: {
    color: theme.colors.danger,
    marginBottom: theme.spacing.md,
    textAlign: 'center',
  },
  info: {
    color: theme.colors.success,
    marginBottom: theme.spacing.md,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    marginTop: theme.spacing.sm,
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.5,
  },
  primaryButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  linkButton: {
    marginTop: theme.spacing.lg,
    alignItems: 'center',
  },
  linkText: {
    color: theme.colors.primary,
    fontSize: 15,
  },
});
