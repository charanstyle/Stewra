import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Briefing } from '@stewra/shared-types';
import { theme } from '../../theme/colors';

interface BriefingCardProps {
  readonly briefing: Briefing | null;
}

/**
 * The natural-language "here's your day" summary at the top of the Today tab. Mirrors the website's
 * BriefingCard: renders nothing when there's no briefing yet — the screen's empty state covers that.
 */
export function BriefingCard({ briefing }: BriefingCardProps): React.JSX.Element | null {
  if (briefing === null) {
    return null;
  }

  return (
    <View style={styles.card} testID="today-briefing">
      <Text style={styles.summary}>{briefing.summary}</Text>
      {briefing.sections.map((section, i) => (
        <View key={`${section.heading}-${i}`} style={styles.section}>
          <Text style={styles.sectionHeading}>{section.heading}</Text>
          <Text style={styles.sectionBody}>{section.body}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  summary: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    lineHeight: 22,
  },
  section: {
    marginTop: theme.spacing.xs,
  },
  sectionHeading: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  sectionBody: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
});
