import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Connection } from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import { theme } from '../../theme/colors';

/**
 * Connections management in Settings — the mobile mirror of the website ActivityPage's connections
 * panel: every connected source with its status, a Disconnect that revokes at the provider (not just
 * locally), and "Connect Google", which shows the backend's plain-language consent prompt before
 * opening the OAuth page in the browser. The consent copy comes from the server so both clients ask
 * with the same words. Bank connections (Plaid Link) need the native Link SDK and are not offered
 * here yet — an existing bank connection still lists and disconnects like any other.
 */
export function ConnectionsCard(): React.JSX.Element {
  const [connections, setConnections] = useState<ReadonlyArray<Connection>>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const res = await api.listConnections();
    setConnections(res.connections);
  }, []);

  useEffect(() => {
    load()
      .catch(() => setError('Failed to load your connections'))
      .finally(() => setLoading(false));
  }, [load]);

  const connectGoogle = useCallback((): void => {
    setError(null);
    setConnecting(true);
    void api
      .startGoogleConnection()
      .then((res) =>
        new Promise<void>((resolve) => {
          // The backend's consent prompt, word for word — the user agrees to the same sentence on
          // every client. Continue opens the real Google consent page in the browser.
          Alert.alert('Connect Google', res.consentPrompt, [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
            {
              text: 'Continue',
              onPress: () => {
                void Linking.openURL(res.authorizeUrl).catch(() =>
                  setError('Could not open the browser'),
                );
                resolve();
              },
            },
          ]);
        }),
      )
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not start the connection'),
      )
      .finally(() => setConnecting(false));
  }, []);

  const disconnect = useCallback(
    (connection: Connection): void => {
      Alert.alert(
        'Disconnect?',
        `Stewra will revoke its access to ${connection.accountEmail || connection.provider} at the provider and stop reading from it.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disconnect',
            style: 'destructive',
            onPress: () => {
              setError(null);
              setBusyId(connection.id);
              void api
                .disconnect(connection.id)
                .then(() => load())
                .catch((err: unknown) =>
                  setError(err instanceof ApiError ? err.message : 'Could not disconnect'),
                )
                .finally(() => setBusyId(null));
            },
          },
        ],
      );
    },
    [load],
  );

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Connections</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? (
        <ActivityIndicator color={theme.colors.primary} />
      ) : connections.length === 0 ? (
        <Text style={styles.emptyText}>No sources connected yet.</Text>
      ) : (
        connections.map((connection) => (
          <View key={connection.id} style={styles.row} testID="settings-connection-row">
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{connection.accountEmail || connection.provider}</Text>
              <Text style={styles.rowStatus}>
                {connection.status === 'active'
                  ? connection.needsReconsent
                    ? 'Needs reconnecting'
                    : 'Active'
                  : 'Disconnected'}
              </Text>
            </View>
            {connection.status === 'active' ? (
              <Pressable
                accessibilityRole="button"
                disabled={busyId !== null}
                onPress={() => disconnect(connection)}
                style={({ pressed }) => pressed && styles.pressed}
              >
                {busyId === connection.id ? (
                  <ActivityIndicator color={theme.colors.danger} />
                ) : (
                  <Text style={styles.disconnectText}>Disconnect</Text>
                )}
              </Pressable>
            ) : null}
          </View>
        ))
      )}
      <Pressable
        accessibilityRole="button"
        disabled={connecting}
        onPress={connectGoogle}
        style={({ pressed }) => [styles.connectButton, pressed && styles.pressed]}
        testID="settings-connect-google"
      >
        {connecting ? (
          <ActivityIndicator color={theme.colors.primary} />
        ) : (
          <Text style={styles.connectText}>Connect a Google account</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    color: theme.colors.textPrimary,
    fontSize: 14,
  },
  rowStatus: {
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
  disconnectText: {
    color: theme.colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  connectButton: {
    marginTop: theme.spacing.xs,
    height: 40,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 13,
  },
});
