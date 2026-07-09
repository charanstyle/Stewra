import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { MessageStatus } from '@stewra/shared-types';
import { CheckIcon, CheckCheckIcon } from '../icons/Icons';
import { theme } from '../../theme/colors';

interface MessageStatusIndicatorProps {
  readonly status: MessageStatus;
  readonly size?: number;
}

/**
 * The WhatsApp-style delivery glyph for the caller's OWN outgoing bubbles:
 *   sending → spinner · sent → one tick · delivered → two grey ticks · read → two accent ticks ·
 *   failed → a red "!". Incoming bubbles pass no indicator (only own messages carry a meaningful tick).
 */
export function MessageStatusIndicator({
  status,
  size = 14,
}: MessageStatusIndicatorProps): React.JSX.Element | null {
  switch (status) {
    case 'sending':
      return <ActivityIndicator size="small" color={theme.colors.textSecondary} style={styles.wrap} />;
    case 'sent':
      return (
        <View style={styles.wrap}>
          <CheckIcon size={size} color={theme.colors.textSecondary} />
        </View>
      );
    case 'delivered':
      return (
        <View style={styles.wrap}>
          <CheckCheckIcon size={size} color={theme.colors.textSecondary} />
        </View>
      );
    case 'read':
      return (
        <View style={styles.wrap}>
          <CheckCheckIcon size={size} color={theme.colors.primary} />
        </View>
      );
    case 'failed':
      return <Text style={[styles.wrap, styles.failed]}>!</Text>;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  wrap: {
    marginLeft: 4,
  },
  failed: {
    color: theme.colors.danger,
    fontWeight: '700',
    fontSize: 13,
  },
});

export default MessageStatusIndicator;
