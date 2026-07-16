import type { ResourceKind } from '@stewra/shared-types';
import * as Sentry from '@sentry/node';
import { connectionRepository } from '../repositories/connectionRepository.js';
import { vault } from '../control-plane/vault/vault.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { preferencesService } from './preferencesService.js';
import { processMemoryService } from './processMemoryService.js';
import { extractCalendarFacts } from './calendarFacts.js';
import { extractGmailFacts } from './gmailFacts.js';
import { fetchUpcomingEvents, fetchRecentEmails, isGoogleAuthError } from './googleOAuthService.js';
import type { ConnectionRow } from '../repositories/connectionRepository.js';

/**
 * Fetches MINIMIZED DERIVED FACTS for a connected source, server-side, using a token read from the
 * vault. The raw records (calendar events, email metadata) are fetched and reduced to short facts
 * HERE; only those fact strings are returned and cross the broker to the agent. A user may have
 * several Google accounts connected — facts are gathered across all of them and labelled by account
 * when there is more than one.
 */
export class ConnectionService {
  async fetchDerivedFacts(userId: string, kind: ResourceKind): Promise<ReadonlyArray<string>> {
    if (kind === 'calendar' || kind === 'gmail') {
      return this.googleFacts(userId, kind);
    }
    throw new Error(
      `ConnectionService.fetchDerivedFacts(${kind}) is not implemented yet ` +
        `(money/memory arrive in a later milestone).`,
    );
  }

  private async googleFacts(
    userId: string,
    kind: 'calendar' | 'gmail',
  ): Promise<ReadonlyArray<string>> {
    const connections = await connectionRepository.listActive(userId, 'google');
    const labelByAccount = connections.length > 1;
    const now = new Date();
    const facts: string[] = [];

    // The Gmail lookback window is the user's stored preference (with the configured default as a
    // fallback) — resolved once here, server-side, so it never crosses the broker to the agent.
    const gmailLookbackDays =
      kind === 'gmail' ? await preferencesService.gmailLookbackDays(userId) : 0;

    for (const connection of connections) {
      let accountFacts: ReadonlyArray<string>;
      try {
        const refreshToken = await vault.get(connection.vaultRef);
        accountFacts =
          kind === 'calendar'
            ? extractCalendarFacts(await fetchUpcomingEvents(refreshToken), now)
            : extractGmailFacts(await fetchRecentEmails(refreshToken, gmailLookbackDays), now);
      } catch (error) {
        // One account failing must not sink the others — gather partial facts and move on. A lost
        // grant (revoked/expired token) is terminal, so we flip the connection to `revoked` and
        // audit it; a transient failure (rate limit, network) is just captured and skipped.
        await this.handleFetchError(connection, kind, error);
        continue;
      }

      for (const fact of accountFacts) {
        facts.push(labelByAccount ? `[${connection.accountEmail}] ${fact}` : fact);
      }
    }

    // Opportunistically let the experiential style observer learn from the user's Sent mail on the
    // Gmail cadence. Self-gated by the user's opt-in (no-op when off) and fully best-effort: it never
    // adds to, blocks, or fails the derived facts the caller actually asked for.
    if (kind === 'gmail') {
      try {
        await processMemoryService.observeFromSentMail(userId);
      } catch (error) {
        Sentry.captureException(error);
      }
    }

    return facts;
  }

  /**
   * React to a per-account fetch failure. Terminal auth failures revoke the connection (so the UI
   * shows it needs reconnecting) and are audited; everything else is reported to Sentry and left
   * active to retry next time. Never rethrows — the caller wants partial facts, not a hard failure.
   */
  private async handleFetchError(
    connection: ConnectionRow,
    kind: 'calendar' | 'gmail',
    error: unknown,
  ): Promise<void> {
    Sentry.captureException(error);
    if (!isGoogleAuthError(error)) {
      return;
    }
    await connectionRepository.setStatus(connection.id, 'revoked');
    await auditWriter.write({
      userId: connection.userId,
      action: 'disconnect',
      resourceType: kind,
      resourceId: connection.id,
      summary: `Lost access to Google account ${connection.accountEmail} — please reconnect`,
      success: false,
      metadata: { accountEmail: connection.accountEmail, reason: 'token_revoked_or_expired' },
    });
  }
}

export const connectionService = new ConnectionService();
