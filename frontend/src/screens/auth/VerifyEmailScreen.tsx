import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EMAIL_VERIFICATION_CODE_LENGTH } from '@stewra/shared-types';
import { useAuth } from '../../contexts/AuthContext';
import { api, ApiError } from '../../services/api';
import { theme } from '../../theme/colors';

export default function VerifyEmailScreen(): React.JSX.Element {
  const { applyUser, logout } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);

  const handleVerify = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      const res = await api.verifyEmail({ code });
      applyUser(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    setResending(true);
    try {
      await api.resendVerification();
      setInfo('A new code has been sent to your email.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not resend the code.');
    } finally {
      setResending(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.subtitle}>
          Enter the {EMAIL_VERIFICATION_CODE_LENGTH}-digit code we sent to verify your account.
        </Text>

        <TextInput
          style={styles.codeInput}
          placeholder="000000"
          placeholderTextColor={theme.colors.textSecondary}
          keyboardType="number-pad"
          maxLength={EMAIL_VERIFICATION_CODE_LENGTH}
          value={code}
          onChangeText={setCode}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {info ? <Text style={styles.info}>{info}</Text> : null}

        <Pressable
          accessibilityRole="button"
          disabled={submitting || code.length !== EMAIL_VERIFICATION_CODE_LENGTH}
          onPress={() => void handleVerify()}
          style={({ pressed }) => [
            styles.primaryButton,
            (pressed || submitting) && styles.pressed,
            code.length !== EMAIL_VERIFICATION_CODE_LENGTH && styles.disabled,
          ]}
        >
          {submitting ? (
            <ActivityIndicator color={theme.colors.onPrimary} />
          ) : (
            <Text style={styles.primaryButtonLabel}>Verify</Text>
          )}
        </Pressable>

        <Pressable disabled={resending} onPress={() => void handleResend()} style={styles.linkButton}>
          <Text style={styles.linkText}>{resending ? 'Sending…' : 'Resend code'}</Text>
        </Pressable>

        <Pressable onPress={() => void logout()} style={styles.linkButton}>
          <Text style={styles.linkText}>Sign out</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
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
