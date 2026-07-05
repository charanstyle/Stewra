import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { ConversationSummary } from '@stewra/shared-types';
import type { MainTabParamList } from '../../navigation/types';
import { api } from '../../services/api';
import { theme } from '../../theme/colors';

type Props = BottomTabScreenProps<MainTabParamList, 'Chats'>;

function titleFor(summary: ConversationSummary): string {
  if (summary.conversation.type === 'stewra_ai') {
    return 'Stewra';
  }
  if (summary.conversation.title) {
    return summary.conversation.title;
  }
  return summary.participants.map((participant) => participant.displayName).join(', ') || 'Conversation';
}

export default function ChatListScreen({ navigation }: Props): React.JSX.Element {
  const [conversations, setConversations] = useState<ReadonlyArray<ConversationSummary>>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    const [conversationsRes, stewraRes] = await Promise.all([
      api.listConversations(),
      api.getStewraConversation(),
    ]);
    const withoutStewra = conversationsRes.conversations.filter(
      (summary) => summary.conversation.type !== 'stewra_ai',
    );
    setConversations([stewraRes.conversation, ...withoutStewra]);
  }, []);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      void load();
    });
    return unsubscribe;
  }, [navigation, load]);

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const renderItem = ({ item }: { item: ConversationSummary }): React.JSX.Element => {
    const title = titleFor(item);
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.navigate('Conversation', { conversationId: item.conversation.id, title })}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarInitial}>{title.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.rowPreview} numberOfLines={1}>
            {item.lastMessage ? item.lastMessage.preview : 'No messages yet'}
          </Text>
        </View>
        {item.unreadCount > 0 ? (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadCount}>{item.unreadCount}</Text>
          </View>
        ) : null}
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {!loading && conversations.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No conversations yet</Text>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.conversation.id}
          renderItem={renderItem}
          removeClippedSubviews
          maxToRenderPerBatch={12}
          windowSize={7}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  rowPressed: {
    opacity: 0.7,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.md,
  },
  avatarInitial: {
    color: theme.colors.onPrimary,
    fontSize: 18,
    fontWeight: '600',
  },
  rowBody: {
    flex: 1,
  },
  rowTitle: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  rowPreview: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    marginTop: 2,
  },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadCount: {
    color: theme.colors.onPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: 15,
  },
});
