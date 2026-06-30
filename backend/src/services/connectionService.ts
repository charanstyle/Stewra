import type { ResourceKind } from '@stewra/shared-types';
import { connectionRepository } from '../repositories/connectionRepository';
import { vault } from '../control-plane/vault/vault';
import { preferencesService } from './preferencesService';
import { extractCalendarFacts } from './calendarFacts';
import { extractGmailFacts } from './gmailFacts';
import { fetchUpcomingEvents, fetchRecentEmails } from './googleOAuthService';

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
      const refreshToken = await vault.get(connection.vaultRef);
      const accountFacts =
        kind === 'calendar'
          ? extractCalendarFacts(await fetchUpcomingEvents(refreshToken), now)
          : extractGmailFacts(await fetchRecentEmails(refreshToken, gmailLookbackDays), now);

      for (const fact of accountFacts) {
        facts.push(labelByAccount ? `[${connection.accountEmail}] ${fact}` : fact);
      }
    }

    return facts;
  }
}

export const connectionService = new ConnectionService();
