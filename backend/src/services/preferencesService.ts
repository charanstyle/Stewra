import {
  GMAIL_LOOKBACK_MIN_DAYS,
  GMAIL_LOOKBACK_MAX_DAYS,
  type UserPreferences,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { userPreferencesRepository } from '../repositories/userPreferencesRepository.js';
import { ValidationError } from '../utils/errors.js';

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
      // The Sent-mail observer is off until the user turns it on — no row (or no opt-in) means off.
      learnFromSentMail: stored?.learnFromSentMail ?? false,
      // Read receipts are on by default (WhatsApp behavior); only an explicit opt-out turns them off.
      readReceiptsEnabled: stored?.readReceiptsEnabled ?? true,
      // Approve-to-send email over WhatsApp is off until the user turns it on (password-gated elsewhere).
      sendEmailOverWhatsapp: stored?.sendEmailOverWhatsapp ?? false,
    };
  }

  /** Whether the user shares read receipts — the gate the chat read path checks before writing/emitting. */
  async readReceiptsEnabled(userId: string): Promise<boolean> {
    const prefs = await this.getForUser(userId);
    return prefs.readReceiptsEnabled;
  }

  /** The effective Gmail lookback window (days) for a user — the only consumer in the data path. */
  async gmailLookbackDays(userId: string): Promise<number> {
    const prefs = await this.getForUser(userId);
    return prefs.gmailLookbackDays;
  }

  /** Whether the user has opted the Sent-mail style observer in — the gate the observer checks. */
  async learnFromSentMail(userId: string): Promise<boolean> {
    const prefs = await this.getForUser(userId);
    return prefs.learnFromSentMail;
  }

  /**
   * The user's STORED approve-to-send opt-in — their consent, and nothing more.
   *
   * ⚠️ Not the gate. This ignores the `WHATSAPP_EMAIL_APPROVAL_ENABLED` kill-switch, so a caller that
   * gates on it alone keeps serving the feature to opted-in users after it has been switched off in prod.
   * Anything deciding whether approve-to-send is LIVE must call `whatsappEmailApprovalService.isActiveFor`,
   * which folds in the kill-switch. This getter exists for that service (and for reporting stored state).
   *
   * Writing the opt-in is password-gated and lives in `whatsappEmailApprovalService`, NOT in `update()`.
   */
  async sendEmailOverWhatsapp(userId: string): Promise<boolean> {
    const prefs = await this.getForUser(userId);
    return prefs.sendEmailOverWhatsapp;
  }

  /**
   * The effective email retention window (days) for a user — how far back the sync engine keeps mail
   * and past which the retention sweep expires it. Resolves the durable per-user choice, falling back
   * to the deploy default when the user hasn't set one. The single source of the effective window.
   */
  async emailRetentionDays(userId: string): Promise<number> {
    const stored = await userPreferencesRepository.findForUser(userId);
    return stored?.emailRetentionDays ?? config.emailSync.retentionDefaultDays;
  }

  /**
   * Apply a partial update. Validates each provided field against the shared bounds, persists it,
   * and returns the full resolved preferences. Omitted fields are left unchanged.
   */
  async update(
    userId: string,
    patch: {
      gmailLookbackDays?: number | undefined;
      learnFromSentMail?: boolean | undefined;
      readReceiptsEnabled?: boolean | undefined;
    },
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
    if (patch.learnFromSentMail !== undefined) {
      // On first write the row needs a concrete lookback (NOT NULL, no DB default) — supply the
      // effective one so flipping the opt-in never depends on a lookback having been set first.
      const lookbackForInsert = await this.gmailLookbackDays(userId);
      await userPreferencesRepository.upsertLearnFromSentMail(
        userId,
        patch.learnFromSentMail,
        lookbackForInsert,
      );
    }
    if (patch.readReceiptsEnabled !== undefined) {
      // Same first-write concern as the other opt-ins: supply the effective lookback so the row can be
      // created NOT-NULL even when the user has never set a lookback.
      const lookbackForInsert = await this.gmailLookbackDays(userId);
      await userPreferencesRepository.upsertReadReceiptsEnabled(
        userId,
        patch.readReceiptsEnabled,
        lookbackForInsert,
      );
    }
    return this.getForUser(userId);
  }
}

export const preferencesService = new PreferencesService();
