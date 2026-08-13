import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AuditEvent } from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import { theme } from '../../theme/colors';

/**
 * The plain-language activity feed — the mobile mirror of the website ActivityPage's feed half:
 * every audited action ("Refreshed your daily briefing", "Read your calendar", "Paused Stewra"),
 * newest first, with a success/failure dot. This is the product's accountability surface: the
 * answer to "what has Stewra looked at?" is this list, and nothing reads data without landing here.
 */
export default function ActivityScreen(): React.JSX.Element {
  const [events, setEvents] = useState<ReadonlyArray<AuditEvent>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const res = await api.listActivity();
    setEvents(res.items);
  }, []);

  useEffect(() => {
    load()
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Something went wrong'),
      )
      .finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = useCallback((): void => {
    setRefreshing(true);
    setError(null);
    void load()
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Something went wrong'),
      )
      .finally(() => setRefreshing(false));
  }, [load]);

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
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={events}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ActivityRow event={item} />}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
          />
        }
        ListEmptyComponent={<Text style={styles.emptyText}>No activity yet.</Text>}
        removeClippedSubviews
        maxToRenderPerBatch={20}
        windowSize={7}
      />
    </SafeAreaView>
  );
}

function ActivityRow({ event }: { readonly event: AuditEvent }): React.JSX.Element {
  return (
    <View style={styles.row} testID="activity-row">
      <View style={[styles.dot, event.success ? styles.dotOk : styles.dotFail]} />
      <View style={styles.rowText}>
        <Text style={styles.summary}>{event.summary}</Text>
        <Text style={styles.timestamp}>{new Date(event.createdAt).toLocaleString()}</Text>
      </View>
    </View>
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
  list: {
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
  },
  dotOk: {
    backgroundColor: theme.colors.success,
  },
  dotFail: {
    backgroundColor: theme.colors.danger,
  },
  rowText: {
    flex: 1,
  },
  summary: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  timestamp: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: theme.spacing.lg,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 13,
    padding: theme.spacing.md,
  },
});
