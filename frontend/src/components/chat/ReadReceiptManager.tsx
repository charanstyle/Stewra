import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Message, PublicUser, ReadReceipt } from '@stewra/shared-types';
import { api } from '../../services/api';
import { theme } from '../../theme/colors';
import { TinyAvatar } from './TinyAvatar';

interface ReadReceiptManagerProps {
  /** The outgoing message whose receipts to show, or null when the sheet is closed. */
  readonly message: Message | null;
  /** The conversation's other participants, for naming/photographing each reader. */
  readonly participants: ReadonlyArray<PublicUser>;
  readonly onClose: () => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Bottom-sheet detail of who has read one outgoing message and when. Fetches the authoritative receipt
 * list on open (the live `readReceipts` render immediately; the refetch reconciles anything missed).
 */
export function ReadReceiptManager({
  message,
  participants,
  onClose,
}: ReadReceiptManagerProps): React.JSX.Element {
  const [receipts, setReceipts] = useState<ReadonlyArray<ReadReceipt>>([]);

  useEffect(() => {
    if (message === null) {
      return;
    }
    setReceipts(message.readReceipts);
    let active = true;
    api
      .listMessageReceipts(message.id)
      .then((res) => {
        if (active) setReceipts(res.receipts);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [message]);

  const readByUserId = new Map(receipts.map((r) => [r.userId, r]));
  const delivered = message?.deliveredAt ?? null;

  return (
    <Modal
      visible={message !== null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.handle} />
          <Text style={styles.title}>Message info</Text>
          <ScrollView style={styles.list}>
            {participants.map((p) => {
              const receipt = readByUserId.get(p.id);
              return (
                <View key={p.id} style={styles.row}>
                  <TinyAvatar name={p.displayName} avatarUrl={p.avatarUrl} size={34} />
                  <View style={styles.who}>
                    <Text style={styles.name}>{p.displayName}</Text>
                    <Text style={styles.state}>
                      {receipt
                        ? `Read ${formatTime(receipt.readAt)}`
                        : delivered
                          ? `Delivered ${formatTime(delivered)}`
                          : 'Sent'}
                    </Text>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.xl,
    paddingTop: theme.spacing.sm,
    maxHeight: '70%',
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.border,
    marginBottom: theme.spacing.md,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: theme.spacing.sm,
  },
  list: {
    flexGrow: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  who: {
    flex: 1,
  },
  name: {
    color: theme.colors.textPrimary,
    fontSize: 15,
  },
  state: {
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
});

export default ReadReceiptManager;
