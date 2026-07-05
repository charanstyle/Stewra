import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { ContactInviteWithUsers, PublicUser } from '@stewra/shared-types';
import type { MainTabParamList } from '../../navigation/types';
import { useContacts } from '../../contexts/ContactsContext';
import { api, ApiError } from '../../services/api';
import { theme } from '../../theme/colors';

type Props = BottomTabScreenProps<MainTabParamList, 'Contacts'>;

export default function ContactsScreen({ navigation }: Props): React.JSX.Element {
  const { contacts, loading, refresh, invitesRevision } = useContacts();
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ReadonlyArray<PublicUser>>([]);
  const [received, setReceived] = useState<ReadonlyArray<ContactInviteWithUsers>>([]);
  const [message, setMessage] = useState<string | null>(null);

  const loadInvites = useCallback(async (): Promise<void> => {
    const res = await api.listInvites();
    setReceived(res.received.filter((entry) => entry.invite.status === 'pending'));
  }, []);

  // Reload on mount and whenever a new invite arrives over the socket (invitesRevision bumps).
  useEffect(() => {
    void loadInvites();
  }, [loadInvites, invitesRevision]);

  const handleSearch = async (text: string): Promise<void> => {
    setQuery(text);
    if (text.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const res = await api.searchUsers({ query: text.trim() });
    setSearchResults(res.users);
  };

  const handleInvite = async (email: string): Promise<void> => {
    setMessage(null);
    try {
      await api.sendInvite({ inviteeEmail: email });
      setMessage(`Invite sent to ${email}`);
      setSearchResults([]);
      setQuery('');
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Could not send invite.');
    }
  };

  const handleRespond = async (inviteId: string, action: 'accept' | 'decline'): Promise<void> => {
    await api.respondInvite(inviteId, { action });
    await Promise.all([loadInvites(), refresh()]);
  };

  const handleOpenConversation = async (userId: string, displayName: string): Promise<void> => {
    const res = await api.createConversation({ type: 'direct', participantUserIds: [userId] });
    navigation.navigate('Conversation', { conversationId: res.conversation.id, title: displayName });
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or email"
          placeholderTextColor={theme.colors.textSecondary}
          autoCapitalize="none"
          value={query}
          onChangeText={(text) => void handleSearch(text)}
        />
      </View>

      {message ? <Text style={styles.message}>{message}</Text> : null}

      {searchResults.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Search results</Text>
          {searchResults.map((result) => (
            <View key={result.id} style={styles.row}>
              <Text style={styles.rowTitle}>{result.displayName}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void handleInvite(result.email)}
                style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
              >
                <Text style={styles.smallButtonLabel}>Invite</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {received.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pending invites</Text>
          {received.map((entry) => (
            <View key={entry.invite.id} style={styles.row}>
              <View style={styles.inviteFrom}>
                <Text style={styles.rowTitle}>{entry.inviter.displayName} invited you</Text>
                <Text style={styles.rowSubtitle}>{entry.inviter.email}</Text>
              </View>
              <View style={styles.inviteActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void handleRespond(entry.invite.id, 'decline')}
                  style={({ pressed }) => [styles.smallButton, styles.declineButton, pressed && styles.pressed]}
                >
                  <Text style={styles.smallButtonLabel}>Decline</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void handleRespond(entry.invite.id, 'accept')}
                  style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
                >
                  <Text style={styles.smallButtonLabel}>Accept</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <FlatList
        style={styles.list}
        data={contacts.filter((entry) => entry.contact.status === 'active')}
        keyExtractor={(entry) => entry.contact.id}
        refreshing={loading}
        onRefresh={() => void refresh()}
        ListHeaderComponent={<Text style={styles.sectionTitle}>Contacts</Text>}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => void handleOpenConversation(item.user.id, item.user.displayName)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Text style={styles.rowTitle}>{item.user.displayName}</Text>
            <Text style={styles.rowSubtitle}>{item.user.email}</Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  searchBar: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  searchInput: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    color: theme.colors.textPrimary,
    fontSize: 15,
  },
  message: {
    color: theme.colors.textSecondary,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  section: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
  },
  sectionTitle: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: theme.spacing.xs,
  },
  list: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderBottomColor: theme.colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: {
    opacity: 0.7,
  },
  rowTitle: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  rowSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  inviteFrom: {
    flex: 1,
    marginRight: theme.spacing.sm,
  },
  inviteActions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  smallButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 6,
  },
  declineButton: {
    backgroundColor: theme.colors.danger,
  },
  smallButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
});
