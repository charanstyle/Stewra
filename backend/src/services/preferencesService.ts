import {
  GMAIL_LOOKBACK_MIN_DAYS,
  GMAIL_LOOKBACK_MAX_DAYS,
  type UserPreferences,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig';
import { userPreferencesRepository } from '../repositories/userPreferencesRepository';
import { ValidationError } from '../utils/errors';

/**
 * Resolves and updates durable per-user preferences. Reads always return a fully-resolved
 * `UserPreferences` — when the user has never chosen a value, the configured default fills in. This
 * is the single place that decides the effective Gmail lookback window; the control plane calls it
 * server-side so the value never travels through the untrusted agent.
 */
export class PreferencesService {
  /** The user's preferences, with any unset field resolved to the configured default. */
  async getForUser(userId: string): Promise<UserPreferences> {
    const stored = await userPreferencesRepository.findForUser(userId);
    return {
      gmailLookbackDays: stored?.gmailLookbackDays ?? config.gmail.lookbackDays,
    };
  }

  /** The effective Gmail lookback window (days) for a user — the only consumer in the data path. */
  async gmailLookbackDays(userId: string): Promise<number> {
    const prefs = await this.getForUser(userId);
    return prefs.gmailLookbackDays;
  }

  /**
   * Apply a partial update. Validates each provided field against the shared bounds, persists it,
   * and returns the full resolved preferences. Omitted fields are left unchanged.
   */
  async update(
    userId: string,
    patch: { gmailLookbackDays?: number | undefined },
  ): Promise<UserPreferences> {
    if (patch.gmailLookbackDays !== undefined) {
      const days = patch.gmailLookbackDays;
      if (
        !Number.isInteger(days) ||
        days < GMAIL_LOOKBACK_MIN_DAYS ||
        days > GMAIL_LOOKBACK_MAX_DAYS
      ) {
        throw new ValidationError('Invalid Gmail lookback window', [
          {
            field: 'gmailLookbackDays',
            message: `must be an integer between ${GMAIL_LOOKBACK_MIN_DAYS} and ${GMAIL_LOOKBACK_MAX_DAYS}`,
          },
        ]);
      }
      await userPreferencesRepository.upsertGmailLookbackDays(userId, days);
    }
    return this.getForUser(userId);
  }
}

export const preferencesService = new PreferencesService();
