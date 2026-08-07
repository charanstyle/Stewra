import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type {
  ChannelAccount,
  CommerceBroadcast,
  CommerceConversationSummary,
  CommerceMessage,
  MessageTemplate,
  OrgMembership,
} from '@stewra/shared-types';
import { roleMeetsMinimum } from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import { theme } from '../../theme/colors';

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

/** How long is left on the 24-hour reply window, in words. Null when closed or never opened. */
function windowRemaining(expiresAt: string | null): string | null {
  if (expiresAt === null) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

/**
 * The commerce plane's mobile surface: the shared customer inbox, and campaign status at a glance.
 *
 * Deliberately the FALLBACK — texting Stewra is how this product is meant to be driven, and this
 * screen covers what a chat thread is bad at: every customer conversation at once, and "is my
 * campaign actually running". Building campaigns, managing consent, and connecting numbers stay on
 * the website; Meta's Embedded Signup is a browser dialog, and a phone keyboard is the wrong place
 * to write a compliance attestation.
 */
export default function CommerceScreen(): React.JSX.Element {
  const [memberships, setMemberships] = useState<ReadonlyArray<OrgMembership>>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<ReadonlyArray<ChannelAccount>>([]);
  const [conversations, setConversations] = useState<ReadonlyArray<CommerceConversationSummary>>(
    [],
  );
  const [broadcasts, setBroadcasts] = useState<ReadonlyArray<CommerceBroadcast>>([]);
  const [templates, setTemplates] = useState<ReadonlyArray<MessageTemplate>>([]);

  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ReadonlyArray<CommerceMessage>>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const role = memberships.find((m) => m.org.id === orgId)?.role ?? null;
  const openThread = conversations.find((c) => c.id === openThreadId) ?? null;
  const replyWindow = openThread === null ? null : windowRemaining(openThread.serviceWindowExpiresAt);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.listOrgs();
        setMemberships(res.memberships);
        setActiveOrgId(res.activeOrgId);
        setOrgId((current) => current ?? res.activeOrgId ?? res.memberships[0]?.org.id ?? null);
      } catch (err) {
        setError(describeError(err));
      }
    })();
  }, []);

  const loadOrg = useCallback(async (id: string): Promise<void> => {
    try {
      const [channelsRes, conversationsRes, broadcastsRes, templatesRes] = await Promise.all([
        api.listChannelAccounts(id),
        api.listCommerceConversations(id, { limit: 30 }),
        api.listBroadcasts(id),
        api.listMessageTemplates(id),
      ]);
      setAccounts(channelsRes.accounts);
      setConversations(conversationsRes.conversations);
      setBroadcasts(broadcastsRes.broadcasts);
      setTemplates(templatesRes.templates);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    if (orgId === null) return;
    setOpenThreadId(null);
    setMessages([]);
    void loadOrg(orgId);
  }, [orgId, loadOrg]);

  const makeActive = useCallback(async (): Promise<void> => {
    if (orgId === null) return;
    setError(null);
    try {
      const res = await api.setActiveOrg({ orgId });
      setActiveOrgId(res.activeOrgId);
      setNotice('Texting Stewra now acts on this business.');
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId]);

  const openConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      if (openThreadId === conversationId) {
        setOpenThreadId(null);
        return;
      }
      setOpenThreadId(conversationId);
      setMessages([]);
      try {
        const res = await api.listCommerceMessages(orgId, conversationId, { limit: 50 });
        setMessages(res.messages);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, openThreadId],
  );

  const sendReply = useCallback(async (): Promise<void> => {
    if (orgId === null || openThreadId === null) return;
    setError(null);
    setSending(true);
    try {
      const res = await api.sendCommerceMessage(orgId, openThreadId, { body: reply.trim() });
      setMessages((current) => [...current, res.message]);
      setReply('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSending(false);
    }
  }, [orgId, openThreadId, reply]);

  const cancelBroadcast = useCallback(
    async (broadcastId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        const res = await api.cancelBroadcast(orgId, broadcastId);
        setNotice(
          res.broadcast.sentCount > 0
            ? `Cancelled. ${res.broadcast.sentCount} message(s) had already gone out.`
            : 'Cancelled before anything was sent.',
        );
        await loadOrg(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, loadOrg],
  );

  const resumeBroadcast = useCallback(
    async (broadcastId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        await api.resumeBroadcast(orgId, broadcastId);
        setNotice('Resumed — sending continues from where it paused.');
        await loadOrg(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, loadOrg],
  );

  if (memberships.length === 0) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No business yet</Text>
          <Text style={styles.muted}>
            {error ??
              'Create an organization and connect its WhatsApp number on the Stewra website — ' +
                'Meta only allows that step in a browser. Everything after that works from here, ' +
                'or by just texting Stewra.'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {error !== null && <Text style={styles.error}>{error}</Text>}
        {notice !== null && <Text style={styles.notice}>{notice}</Text>}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.orgRow}>
          {memberships.map((m) => (
            <Pressable
              key={m.org.id}
              accessibilityRole="button"
              onPress={() => setOrgId(m.org.id)}
              style={[styles.orgChip, m.org.id === orgId && styles.orgChipActive]}
            >
              <Text style={[styles.orgChipLabel, m.org.id === orgId && styles.orgChipLabelActive]}>
                {m.org.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {orgId !== null && orgId !== activeOrgId && (
          <Pressable
            accessibilityRole="button"
            onPress={() => void makeActive()}
            style={({ pressed }) => [styles.smallButton, styles.standalone, pressed && styles.pressed]}
          >
            <Text style={styles.smallButtonLabel}>Use this business when I text Stewra</Text>
          </Pressable>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Numbers</Text>
          {accounts.length === 0 ? (
            <Text style={styles.muted}>
              No WhatsApp number connected. That step needs a browser — use the website once, then
              everything runs from chat.
            </Text>
          ) : (
            accounts.map((account) => (
              <View key={account.id} style={styles.row}>
                <Text style={styles.rowTitle}>{account.displayName}</Text>
                <Text
                  style={[styles.badge, account.status !== 'active' && styles.badgeError]}
                >
                  {account.status}
                </Text>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Customer inbox</Text>
          {conversations.length === 0 ? (
            <Text style={styles.muted}>No conversations yet.</Text>
          ) : (
            conversations.map((conversation) => (
              <View key={conversation.id}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void openConversation(conversation.id)}
                  style={({ pressed }) => [
                    styles.row,
                    conversation.id === openThreadId && styles.rowActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle}>
                      {conversation.contactDisplayName ??
                        conversation.contactPhoneE164 ??
                        'Unknown contact'}
                    </Text>
                    <Text style={styles.rowSubtitle} numberOfLines={1}>
                      {conversation.lastMessagePreview}
                    </Text>
                  </View>
                </Pressable>
                {conversation.id === openThreadId && (
                  <View style={styles.thread}>
                    {messages.map((message) => (
                      <View
                        key={message.id}
                        style={[
                          styles.bubble,
                          message.direction === 'inbound' ? styles.inbound : styles.outbound,
                          message.status === 'failed' && styles.failedBubble,
                        ]}
                      >
                        <Text style={styles.bubbleText}>{message.body}</Text>
                        {message.status === 'failed' && (
                          <Text style={styles.failedText}>
                            Not delivered{message.failureReason === null ? '' : `: ${message.failureReason}`}
                          </Text>
                        )}
                      </View>
                    ))}
                    {replyWindow === null ? (
                      <Text style={styles.muted}>
                        The 24-hour reply window has closed. Only an approved template (sent from a
                        campaign) can reach this customer now.
                      </Text>
                    ) : (
                      <View style={styles.replyRow}>
                        <TextInput
                          style={styles.replyInput}
                          placeholder={`Reply — ${replyWindow}`}
                          placeholderTextColor={theme.colors.textSecondary}
                          value={reply}
                          onChangeText={setReply}
                          multiline
                        />
                        <Pressable
                          accessibilityRole="button"
                          disabled={
                            sending ||
                            reply.trim() === '' ||
                            role === null ||
                            !roleMeetsMinimum(role, 'agent')
                          }
                          onPress={() => void sendReply()}
                          style={({ pressed }) => [
                            styles.smallButton,
                            pressed && styles.pressed,
                            (sending || reply.trim() === '') && styles.disabled,
                          ]}
                        >
                          <Text style={styles.smallButtonLabel}>{sending ? '…' : 'Send'}</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                )}
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Campaigns</Text>
          {broadcasts.length === 0 ? (
            <Text style={styles.muted}>
              Nothing scheduled. Ask Stewra in chat, or build one on the website.
            </Text>
          ) : (
            broadcasts.map((broadcast) => (
              <View key={broadcast.id} style={styles.row}>
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle}>{broadcast.name}</Text>
                  <Text style={styles.rowSubtitle}>
                    {new Date(broadcast.scheduledFor).toLocaleString()}
                    {broadcast.totalRecipients > 0 &&
                      ` · ${broadcast.sentCount}/${broadcast.totalRecipients} sent` +
                        (broadcast.skippedCount > 0 ? `, ${broadcast.skippedCount} skipped` : '') +
                        (broadcast.failedCount > 0 ? `, ${broadcast.failedCount} failed` : '')}
                  </Text>
                  {broadcast.lastError !== null && (
                    <Text style={styles.rowSubtitle}>{broadcast.lastError}</Text>
                  )}
                </View>
                <View style={styles.rowActions}>
                  <Text
                    style={[
                      styles.badge,
                      (broadcast.status === 'failed' || broadcast.status === 'cancelled') &&
                        styles.badgeError,
                      broadcast.status === 'paused' && styles.badgeWarn,
                    ]}
                  >
                    {broadcast.status}
                  </Text>
                  {role !== null && roleMeetsMinimum(role, 'admin') && (
                    <>
                      {broadcast.status === 'paused' && (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => void resumeBroadcast(broadcast.id)}
                          style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
                        >
                          <Text style={styles.smallButtonLabel}>Resume</Text>
                        </Pressable>
                      )}
                      {(broadcast.status === 'scheduled' ||
                        broadcast.status === 'running' ||
                        broadcast.status === 'paused') && (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => void cancelBroadcast(broadcast.id)}
                          style={({ pressed }) => [
                            styles.smallButton,
                            styles.dangerButton,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text style={styles.smallButtonLabel}>Cancel</Text>
                        </Pressable>
                      )}
                    </>
                  )}
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Templates</Text>
          {templates.length === 0 ? (
            <Text style={styles.muted}>
              No message templates yet. Only a Meta-approved template can open a conversation with a
              customer.
            </Text>
          ) : (
            templates.map((template) => (
              <View key={template.id} style={styles.row}>
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle}>
                    {template.name} · {template.language}
                  </Text>
                  <Text style={styles.rowSubtitle} numberOfLines={2}>
                    {template.bodyText}
                  </Text>
                  {template.rejectionReason !== null && (
                    <Text style={styles.rowSubtitle}>{template.rejectionReason}</Text>
                  )}
                </View>
                <Text
                  style={[styles.badge, template.status !== 'approved' && styles.badgeWarn]}
                >
                  {template.status}
                </Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scroll: {
    paddingBottom: theme.spacing.lg,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  emptyTitle: {
    color: theme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  orgRow: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  orgChip: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    marginRight: theme.spacing.sm,
  },
  orgChipActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  orgChipLabel: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  orgChipLabelActive: {
    color: theme.colors.onPrimary,
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing.sm,
    borderBottomColor: theme.colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: theme.spacing.sm,
  },
  rowActive: {
    backgroundColor: theme.colors.surface,
  },
  rowBody: {
    flex: 1,
  },
  rowActions: {
    alignItems: 'flex-end',
    gap: theme.spacing.xs,
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
  badge: {
    color: theme.colors.textSecondary,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: 2,
    fontSize: 12,
    overflow: 'hidden',
  },
  badgeError: {
    color: theme.colors.danger,
    borderColor: theme.colors.danger,
  },
  badgeWarn: {
    color: theme.colors.textPrimary,
    borderColor: theme.colors.textPrimary,
  },
  muted: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    paddingVertical: theme.spacing.xs,
  },
  error: {
    color: theme.colors.danger,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  notice: {
    color: theme.colors.textSecondary,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  thread: {
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  bubble: {
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    maxWidth: '85%',
  },
  inbound: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.surface,
  },
  outbound: {
    alignSelf: 'flex-end',
    backgroundColor: theme.colors.primary,
  },
  failedBubble: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.danger,
    borderWidth: 1,
  },
  bubbleText: {
    color: theme.colors.textPrimary,
    fontSize: 14,
  },
  failedText: {
    color: theme.colors.danger,
    fontSize: 12,
  },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.xs,
  },
  replyInput: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    color: theme.colors.textPrimary,
    fontSize: 14,
  },
  smallButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  standalone: {
    marginHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
  },
  dangerButton: {
    backgroundColor: theme.colors.danger,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.7,
  },
  smallButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
});
