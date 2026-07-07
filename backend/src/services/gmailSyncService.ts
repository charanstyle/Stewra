import { createHash } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig';
import { vault } from '../control-plane/vault/vault';
import { encryptField } from '../control-plane/vault/fieldCrypto';
import { auditWriter } from '../control-plane/audit/auditWriter';
import { connectionRepository, type ConnectionRow } from '../repositories/connectionRepository';
import { preferencesService } from './preferencesService';
import {
  emailContactRepository,
  emailThreadRepository,
  emailMessageRepository,
  emailSyncStateRepository,
} from '../repositories/emailStore';
import {
  gmailClient,
  listMessageIds,
  getFullMessage,
  listHistory,
  isGoogleAuthError,
  type GmailClient,
  type FetchedMessage,
} from './googleOAuthService';
import { logger } from '../utils/logger';

/**
 * The email sync engine (control plane). Pulls FULL message bodies from Gmail into the encrypted
 * store so Stewra can summarise the inbox, understand a contact's history, and detect who the user
 * owes a reply. Two modes: a rate-limited, resumable BACKFILL of the retention window, then cheap
 * INCREMENTAL syncs via Gmail's history.list. Bodies are encrypted at rest here and never cross to
 * the agent runtime.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Sleep helper for backoff between retried Gmail calls. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry a transient Gmail call with exponential backoff; auth errors fail fast (re-consent needed). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (isGoogleAuthError(error) || attempt >= config.emailSync.maxRetries) {
        throw error;
      }
      const backoffMs = Math.min(30000, 500 * 2 ** attempt);
      await sleep(backoffMs);
      attempt += 1;
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

class GmailSyncService {
  /**
   * Sync every active Google connection for a user. Read-only capable: works on older read-only
   * grants too (full-body read only needs gmail.readonly). Errors on one connection are captured and
   * skipped so a single failure never sinks the user's sync.
   */
  async syncForUser(userId: string): Promise<void> {
    const connections = await connectionRepository.listActive(userId, 'google');
    const retentionDays = await preferencesService.emailRetentionDays(userId);
    for (const connection of connections) {
      try {
        await this.syncConnection(connection, retentionDays);
      } catch (error) {
        Sentry.captureException(error);
        logger.error('gmailSync: connection sync failed', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Sync one connection: backfill until complete, then incremental. */
  async syncConnection(connection: ConnectionRow, retentionDays: number): Promise<void> {
    await emailSyncStateRepository.ensure(connection.id, connection.userId, retentionDays);
    const state = await emailSyncStateRepository.getForConnection(connection.id);
    if (state === undefined) {
      return;
    }

    const refreshToken = await vault.get(connection.vaultRef);
    const gmail = gmailClient(refreshToken);

    let added = 0;
    if (!state.backfillComplete) {
      added = await this.backfill(connection, gmail, retentionDays, state.backfillCursor);
    } else if (state.lastHistoryId) {
      added = await this.incremental(connection, gmail, state.lastHistoryId, retentionDays);
    }

    await emailSyncStateRepository.update(connection.id, { lastSyncedAt: new Date() });

    if (added > 0) {
      await auditWriter.write({
        userId: connection.userId,
        action: 'sync',
        resourceType: 'email',
        resourceId: connection.id,
        summary: `Synced ${added} new email${added === 1 ? '' : 's'} from ${connection.accountEmail}`,
        success: true,
        metadata: { accountEmail: connection.accountEmail, added },
      });
    }
  }

  /** Rate-limited, resumable backfill of the retention window. Returns messages newly stored. */
  private async backfill(
    connection: ConnectionRow,
    gmail: GmailClient,
    retentionDays: number,
    resumeCursor: string | null,
  ): Promise<number> {
    const query = `newer_than:${retentionDays}d`;
    let pageToken: string | undefined = resumeCursor ?? undefined;
    let processed = 0;
    let stored = 0;
    let maxHistoryId: string | null = null;

    for (;;) {
      const page = await withRetry(() =>
        listMessageIds(gmail, query, config.emailSync.backfillPageSize, pageToken),
      );
      for (const id of page.ids) {
        if (processed >= config.emailSync.backfillMaxMessages) {
          break;
        }
        processed += 1;
        const already = await emailMessageRepository.existsByGmailId(connection.id, id);
        if (already) {
          continue;
        }
        const message = await withRetry(() => getFullMessage(gmail, id));
        await this.persistMessage(connection, message);
        maxHistoryId = maxGmailId(maxHistoryId, message.gmailHistoryId);
        stored += 1;
      }

      const hitCap = processed >= config.emailSync.backfillMaxMessages;
      const nextToken = page.nextPageToken;
      if (hitCap || nextToken === null) {
        // Backfill is done (or capped for this window). Record the newest historyId so incremental
        // sync can pick up from here; capping is logged so bounded coverage isn't mistaken for total.
        await emailSyncStateRepository.update(connection.id, {
          backfillCursor: null,
          backfillComplete: true,
          ...(maxHistoryId ? { lastHistoryId: maxHistoryId } : {}),
        });
        if (hitCap && nextToken !== null) {
          logger.info('gmailSync: backfill hit message cap', {
            connectionId: connection.id,
            cap: config.emailSync.backfillMaxMessages,
          });
        }
        break;
      }
      pageToken = nextToken;
      // Persist the cursor each page so a crash resumes rather than restarting the whole window.
      await emailSyncStateRepository.update(connection.id, { backfillCursor: nextToken });
    }
    return stored;
  }

  /** Incremental sync via history.list; falls back to a bounded re-list if the cursor expired. */
  private async incremental(
    connection: ConnectionRow,
    gmail: GmailClient,
    lastHistoryId: string,
    retentionDays: number,
  ): Promise<number> {
    const history = await withRetry(() => listHistory(gmail, lastHistoryId));
    let ids = history.messageIds;
    if (history.expired) {
      // Cursor too old: re-list a bounded recent window instead of the full mailbox.
      const recentDays = Math.min(retentionDays, 7);
      const page = await withRetry(() =>
        listMessageIds(gmail, `newer_than:${recentDays}d`, config.emailSync.backfillPageSize),
      );
      ids = page.ids;
    }

    let stored = 0;
    let maxHistoryId: string | null = history.lastHistoryId;
    for (const id of ids) {
      const already = await emailMessageRepository.existsByGmailId(connection.id, id);
      if (already) {
        continue;
      }
      const message = await withRetry(() => getFullMessage(gmail, id));
      await this.persistMessage(connection, message);
      maxHistoryId = maxGmailId(maxHistoryId, message.gmailHistoryId);
      stored += 1;
    }
    if (maxHistoryId) {
      await emailSyncStateRepository.update(connection.id, { lastHistoryId: maxHistoryId });
    }
    return stored;
  }

  /** Persist one fetched message: resolve thread + (inbound) contact, store the body encrypted, then
   * (re)derive the thread's awaiting-reply state from its actual latest message. */
  private async persistMessage(connection: ConnectionRow, message: FetchedMessage): Promise<void> {
    const direction: 'inbound' | 'outbound' = message.labelIds.includes('SENT')
      ? 'outbound'
      : 'inbound';
    const sentAt = message.sentAt;

    // Only inbound senders become contacts (outbound "from" is the user's own address). The address
    // is vaulted; only its handle + hash live on the row.
    let contactId: string | null = null;
    if (direction === 'inbound' && message.fromAddress.length > 0) {
      const hash = sha256(message.fromAddress);
      const existing = await emailContactRepository.findByHash(connection.id, hash);
      if (existing) {
        contactId = existing.id;
        await emailContactRepository.bumpActivity(existing.id, sentAt ?? new Date(), direction);
      } else {
        const vaultRef = await vault.put(message.fromAddress);
        const created = await emailContactRepository.create({
          userId: connection.userId,
          connectionId: connection.id,
          addressVaultRef: vaultRef,
          addressSha256: hash,
          displayName: message.fromName,
          seenAt: sentAt ?? new Date(),
          direction,
        });
        contactId = created.id;
      }
    }

    const thread = await emailThreadRepository.upsert({
      userId: connection.userId,
      connectionId: connection.id,
      gmailThreadId: message.gmailThreadId,
      subject: message.subject,
      lastMessageAt: sentAt,
      participantContactIds: contactId ? [contactId] : [],
      hasUnread: message.labelIds.includes('UNREAD'),
      awaitingReply: direction === 'inbound',
    });

    await emailMessageRepository.insert({
      userId: connection.userId,
      connectionId: connection.id,
      threadId: thread.id,
      gmailMessageId: message.gmailMessageId,
      gmailHistoryId: message.gmailHistoryId,
      fromContactId: contactId,
      direction,
      sentAt,
      subject: message.subject,
      snippet: message.snippet,
      bodyCiphertext: message.body.length > 0 ? encryptField(message.body) : '',
      labelIds: message.labelIds,
    });

    // Re-derive thread state from the true latest message (backfill can insert out of order).
    const latest = await emailMessageRepository.latestInThread(thread.id);
    if (latest) {
      const awaiting = latest.direction === 'inbound';
      await emailThreadRepository.upsert({
        userId: connection.userId,
        connectionId: connection.id,
        gmailThreadId: message.gmailThreadId,
        subject: thread.subject,
        lastMessageAt: latest.sentAt,
        participantContactIds: contactId ? [contactId] : [],
        hasUnread: latest.labelIds.includes('UNREAD'),
        awaitingReply: awaiting,
      });
      if (contactId) {
        await emailContactRepository.setAwaitingReply(contactId, awaiting);
      }
    }
  }
}

/** Compare two Gmail id strings numerically-by-length-then-lexicographic (they're uint64 as strings). */
function maxGmailId(a: string | null, b: string | null): string | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  if (a.length !== b.length) {
    return a.length > b.length ? a : b;
  }
  return a >= b ? a : b;
}

export { MS_PER_DAY };
export const gmailSyncService = new GmailSyncService();
