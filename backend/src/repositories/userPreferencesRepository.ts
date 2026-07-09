import { db } from '../database/index';
import { config } from '../config/unifiedConfig';

/** A stored preferences row. Absent until the user changes a setting for the first time. */
export interface UserPreferencesRow {
  readonly userId: string;
  readonly gmailLookbackDays: number;
  readonly learnFromSentMail: boolean;
  /** Durable email retention window (days); null when the user hasn't chosen (resolve to default). */
  readonly emailRetentionDays: number | null;
  /** Whether the user shares read receipts in human chats (DB default true). */
  readonly readReceiptsEnabled: boolean;
}

/**
 * Data access for per-user preferences. A row is created lazily on first write; until then the
 * service layer falls back to the configured defaults, so reads can legitimately return undefined.
 */
export class UserPreferencesRepository {
  async findForUser(userId: string): Promise<UserPreferencesRow | undefined> {
    const row = await db
      .selectFrom('user_preferences')
      .select(['user_id', 'gmail_lookback_days', 'learn_from_sent_mail', 'email_retention_days', 'read_receipts_enabled'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? toRow(row) : undefined;
  }

  /** Insert-or-update the user's email retention window (days), stamping updated_at on conflict. */
  async upsertEmailRetentionDays(userId: string, days: number): Promise<UserPreferencesRow> {
    const row = await db
      .insertInto('user_preferences')
      .values({ user_id: userId, gmail_lookback_days: config.gmail.lookbackDays, email_retention_days: days })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ email_retention_days: days, updated_at: new Date() }),
      )
      .returning(['user_id', 'gmail_lookback_days', 'learn_from_sent_mail', 'email_retention_days', 'read_receipts_enabled'])
      .executeTakeFirstOrThrow();
    return toRow(row);
  }

  /** Insert-or-update the user's Gmail lookback window, stamping updated_at on conflict. */
  async upsertGmailLookbackDays(userId: string, days: number): Promise<UserPreferencesRow> {
    const row = await db
      .insertInto('user_preferences')
      .values({ user_id: userId, gmail_lookback_days: days })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ gmail_lookback_days: days, updated_at: new Date() }),
      )
      .returning(['user_id', 'gmail_lookback_days', 'learn_from_sent_mail', 'email_retention_days', 'read_receipts_enabled'])
      .executeTakeFirstOrThrow();
    return toRow(row);
  }

  /**
   * Insert-or-update the Sent-mail learning opt-in. On first write (no row yet) the row must also
   * carry a `gmail_lookback_days` — that column is NOT NULL with no DB default — so the caller passes
   * the resolved default; on conflict only the opt-in (and updated_at) change, leaving any stored
   * lookback untouched.
   */
  async upsertLearnFromSentMail(
    userId: string,
    learn: boolean,
    gmailLookbackDaysForInsert: number,
  ): Promise<UserPreferencesRow> {
    const row = await db
      .insertInto('user_preferences')
      .values({
        user_id: userId,
        gmail_lookback_days: gmailLookbackDaysForInsert,
        learn_from_sent_mail: learn,
      })
      .onConflict((oc) =>
        oc
          .column('user_id')
          .doUpdateSet({ learn_from_sent_mail: learn, updated_at: new Date() }),
      )
      .returning(['user_id', 'gmail_lookback_days', 'learn_from_sent_mail', 'email_retention_days', 'read_receipts_enabled'])
      .executeTakeFirstOrThrow();
    return toRow(row);
  }

  /**
   * Insert-or-update the read-receipt sharing toggle. Like the other opt-ins, first write needs a
   * concrete `gmail_lookback_days` (NOT NULL, no DB default); on conflict only the toggle changes.
   */
  async upsertReadReceiptsEnabled(
    userId: string,
    enabled: boolean,
    gmailLookbackDaysForInsert: number,
  ): Promise<UserPreferencesRow> {
    const row = await db
      .insertInto('user_preferences')
      .values({
        user_id: userId,
        gmail_lookback_days: gmailLookbackDaysForInsert,
        read_receipts_enabled: enabled,
      })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ read_receipts_enabled: enabled, updated_at: new Date() }),
      )
      .returning(['user_id', 'gmail_lookback_days', 'learn_from_sent_mail', 'email_retention_days', 'read_receipts_enabled'])
      .executeTakeFirstOrThrow();
    return toRow(row);
  }
}

/** Map a selected DB row to the camelCase repository shape. */
function toRow(row: {
  user_id: string;
  gmail_lookback_days: number;
  learn_from_sent_mail: boolean;
  email_retention_days: number | null;
  read_receipts_enabled: boolean;
}): UserPreferencesRow {
  return {
    userId: row.user_id,
    gmailLookbackDays: row.gmail_lookback_days,
    learnFromSentMail: row.learn_from_sent_mail,
    emailRetentionDays: row.email_retention_days,
    readReceiptsEnabled: row.read_receipts_enabled,
  };
}

export const userPreferencesRepository = new UserPreferencesRepository();
