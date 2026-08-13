import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { Briefing, Suggestion } from '@stewra/shared-types';
import type { MainTabParamList } from '../../navigation/types';
import { api, ApiError } from '../../services/api';
import { theme } from '../../theme/colors';
import { BriefingCard } from '../../components/today/BriefingCard';
import { NudgeCard } from '../../components/today/NudgeCard';
import { InsightGlance } from '../../components/today/InsightGlance';

type Props = BottomTabScreenProps<MainTabParamList, 'Today'>;

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

/** Time-of-day greeting, same rule as the website's TodayPage. */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The Today tab — the mobile mirror of the website's TodayPage (briefing + nudges) plus the insight
 * glances: what the plan's M4 calls the thin client's job. Reads are plain fetches of what the
 * background job computed; "Refresh" is the one heavier action (sync mail + bank, rebuild) and
 * surfaces the backend's own message when refused — e.g. the 409 while Stewra is paused.
 */
export default function TodayScreen({ navigation }: Props): React.JSX.Element {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [suggestions, setSuggestions] = useState<ReadonlyArray<Suggestion>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [briefingRes, suggestionsRes] = await Promise.all([
      api.getBriefing(),
      api.listSuggestions(),
    ]);
    setBriefing(briefingRes.briefing);
    setSuggestions(suggestionsRes.suggestions);
  }, []);

  useEffect(() => {
    load()
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    return navigation.addListener('focus', () => {
      void load().catch(() => undefined);
    });
  }, [navigation, load]);

  const handleRefresh = useCallback((): void => {
    setRefreshing(true);
    setError(null);
    void load()
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setRefreshing(false));
  }, [load]);

  /** The heavier refresh: sync mail + bank data server-side, then rebuild. Refused while paused. */
  const recompute = useCallback((): void => {
    setRecomputing(true);
    setError(null);
    void api
      .recomputeToday()
      .then((res) => {
        setBriefing(res.briefing);
        return api.listSuggestions().then((s) => setSuggestions(s.suggestions));
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setRecomputing(false));
  }, []);

  const handleResolved = useCallback((id: string): void => {
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleChatOpened = useCallback(
    (conversationId: string): void => {
      navigation.navigate('Conversation', { conversationId, title: 'Stewra' });
    },
    [navigation],
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
          />
        }
      >
        <View style={styles.headerRow}>
          <Text style={styles.greeting}>{greeting()}</Text>
          <Pressable
            accessibilityRole="button"
            disabled={recomputing}
            onPress={recompute}
            style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}
            testID="today-recompute"
          >
            {recomputing ? (
              <ActivityIndicator color={theme.colors.primary} />
            ) : (
              <Text style={styles.refreshText}>Refresh</Text>
            )}
          </Pressable>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <BriefingCard briefing={briefing} />

        {suggestions.length > 0 ? (
          <View style={styles.nudges}>
            <Text style={styles.sectionTitle}>Needs your attention</Text>
            {suggestions.map((suggestion) => (
              <NudgeCard
                key={suggestion.id}
                suggestion={suggestion}
                onResolved={handleResolved}
                onChatOpened={handleChatOpened}
              />
            ))}
          </View>
        ) : (
          <Text style={styles.emptyText}>
            {briefing === null
              ? 'Nothing here yet — connect a source and Stewra will start briefing you.'
              : "You're all caught up."}
          </Text>
        )}

        <InsightGlance />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    padding: theme.spacing.md,
    gap: theme.spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  greeting: {
    color: theme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '700',
  },
  refreshButton: {
    borderWidth: 1,
    borderColor: theme.colors.primary,
    borderRadius: theme.radius.pill,
    paddingVertical: 6,
    paddingHorizontal: theme.spacing.md,
  },
  refreshText: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
  sectionTitle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  nudges: {
    gap: theme.spacing.sm,
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: theme.spacing.md,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 13,
  },
});
