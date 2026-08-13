import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig.js';
import { vault } from '../control-plane/vault/vault.js';
import { encryptField } from '../control-plane/vault/fieldCrypto.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { connectionRepository, type ConnectionRow } from '../repositories/connectionRepository.js';
import {
  moneyAccountRepository,
  moneySyncStateRepository,
  moneyTransactionRepository,
} from '../repositories/moneyStore.js';
import {
  fetchAccounts,
  isPlaidAuthError,
  transactionsSync,
  type PlaidTransaction,
} from './plaidService.js';
import { logger } from '../utils/logger.js';

/**
 * The transactions sync engine (control plane), the money counterpart of `gmailSyncService`. Pulls
 * accounts + balances and walks Plaid's /transactions/sync cursor into the money store, persisting
 * the cursor after every page so a crash resumes rather than restarting. Merchant text is encrypted
 * at rest here and never crosses to the agent runtime.
 *
 * A terminal Plaid auth error (the user's bank grant is gone) flips the connection to `revoked` and
 * audits it — the same contract `connectionService.handleFetchError` keeps for Google.
 */

/** Sleep helper for backoff between retried Plaid calls. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry a transient Plaid call with exponential backoff; auth errors fail fast (reconnect needed). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (isPlaidAuthError(error) || attempt >= config.moneySync.maxRetries) {
        throw error;
      }
      const backoffMs = Math.min(30000, 500 * 2 ** attempt);
      await sleep(backoffMs);
      attempt += 1;
    }
  }
}

class TransactionSyncService {
  /**
   * Sync every active bank connection for a user. Errors on one connection are captured and skipped
   * so a single failed bank never sinks the user's sync — except a terminal auth loss, which also
   * revokes that connection so the UI says "reconnect" instead of silently serving stale facts.
   */
  async syncForUser(userId: string): Promise<void> {
    const connections = await connectionRepository.listActive(userId, 'aggregator');
    for (const connection of connections) {
      try {
        await this.syncConnection(connection);
      } catch (error) {
        Sentry.captureException(error);
        logger.error('transactionSync: connection sync failed', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
        if (isPlaidAuthError(error)) {
          await connectionRepository.setStatus(connection.id, 'revoked');
          await auditWriter.write({
            userId: connection.userId,
            action: 'disconnect',
            resourceType: 'money',
            resourceId: connection.id,
            summary: 'Lost access to a connected bank — please reconnect',
            success: false,
            metadata: { itemId: connection.accountEmail, reason: 'bank_grant_revoked_or_expired' },
          });
        }
      }
    }
  }

  /** Sync one connection: refresh accounts + balances, then walk the transactions cursor. */
  async syncConnection(connection: ConnectionRow): Promise<void> {
    await moneySyncStateRepository.ensure(connection.id, connection.userId);
    const state = await moneySyncStateRepository.getForConnection(connection.id);
    if (state === undefined) {
      return;
    }

    const accessToken = await vault.get(connection.vaultRef);

    // Accounts first: balances are a snapshot (overwritten each sync), and transactions need the
    // account rows to attach to.
    const accounts = await withRetry(() => fetchAccounts(accessToken));
    const balanceAsOf = new Date();
    const accountIdByPlaidId = new Map<string, string>();
    for (const account of accounts) {
      const row = await moneyAccountRepository.upsert({
        userId: connection.userId,
        connectionId: connection.id,
        plaidAccountId: account.accountId,
        name: account.name,
        accountType: account.type,
        accountSubtype: account.subtype,
        mask: account.mask,
        isoCurrencyCode: account.isoCurrencyCode,
        availableMicros: account.availableMicros,
        currentMicros: account.currentMicros,
        balanceAsOf,
      });
      accountIdByPlaidId.set(account.accountId, row.id);
    }

    let cursor = state.cursor;
    let added = 0;
    for (;;) {
      const page = await withRetry(() => transactionsSync(accessToken, cursor));
      for (const t of [...page.added, ...page.modified]) {
        await this.persistTransaction(connection, accountIdByPlaidId, t);
      }
      added += page.added.length;
      await moneyTransactionRepository.deleteByPlaidIds(connection.id, page.removedIds);

      cursor = page.nextCursor;
      // Persist the cursor each page so a crash resumes rather than replaying the whole history.
      await moneySyncStateRepository.update(connection.id, { cursor });
      if (!page.hasMore) {
        break;
      }
    }

    await moneySyncStateRepository.update(connection.id, {
      initialSyncComplete: true,
      lastSyncedAt: new Date(),
    });

    if (added > 0) {
      await auditWriter.write({
        userId: connection.userId,
        action: 'sync',
        resourceType: 'money',
        resourceId: connection.id,
        summary: `Synced ${added} new bank transaction${added === 1 ? '' : 's'}`,
        success: true,
        metadata: { itemId: connection.accountEmail, added },
      });
    }
  }

  /** Store one transaction, merchant encrypted. A transaction on an account this sync didn't see is
   * skipped loudly — inventing an account row for it would put money on a phantom account. */
  private async persistTransaction(
    connection: ConnectionRow,
    accountIdByPlaidId: ReadonlyMap<string, string>,
    t: PlaidTransaction,
  ): Promise<void> {
    const accountId = accountIdByPlaidId.get(t.accountId);
    if (accountId === undefined) {
      logger.error('transactionSync: transaction references an unknown account, skipping', {
        connectionId: connection.id,
        plaidTransactionId: t.transactionId,
      });
      return;
    }
    await moneyTransactionRepository.upsert({
      userId: connection.userId,
      connectionId: connection.id,
      accountId,
      plaidTransactionId: t.transactionId,
      merchantCiphertext: t.merchant.length > 0 ? encryptField(t.merchant) : '',
      category: t.category,
      amountMicros: t.amountMicros,
      isoCurrencyCode: t.isoCurrencyCode,
      postedAt: t.postedAt,
      pending: t.pending,
    });
  }
}

export const transactionSyncService = new TransactionSyncService();
