/**
 * A password field with a show/hide toggle. The eye button flips `secureTextEntry` so a user can
 * verify what they typed before submitting — the single most common cause of "invalid password" on
 * mobile (autocorrect spaces, auto-capitalized first letter, wrong key). Owns its own visibility
 * state and reproduces the shared input styling so it drops in wherever a bare password `TextInput`
 * was used.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { theme } from '../theme/colors';
import { EyeIcon, EyeOffIcon } from './icons/Icons';

type Props = Omit<TextInputProps, 'secureTextEntry'>;

export default function PasswordInput(props: Props): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  const { style, placeholderTextColor, ...rest } = props;

  return (
    <View style={styles.wrapper}>
      <TextInput
        {...rest}
        style={[styles.input, style]}
        secureTextEntry={!visible}
        placeholderTextColor={placeholderTextColor ?? theme.colors.textSecondary}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={visible ? 'Hide password' : 'Show password'}
        hitSlop={8}
        onPress={() => setVisible((v) => !v)}
        style={styles.toggle}
      >
        {visible ? (
          <EyeOffIcon size={20} color={theme.colors.textSecondary} />
        ) : (
          <EyeIcon size={20} color={theme.colors.textSecondary} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    marginBottom: theme.spacing.md,
    paddingRight: theme.spacing.sm,
  },
  input: {
    flex: 1,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    color: theme.colors.textPrimary,
    fontSize: 16,
  },
  toggle: {
    padding: theme.spacing.sm,
  },
});
