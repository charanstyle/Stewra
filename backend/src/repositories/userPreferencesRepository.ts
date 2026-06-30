import { db } from '../database/index';

/** A stored preferences row. Absent until the user changes a setting for the first time. */
export interface UserPreferencesRow {
  readonly userId: string;
  readonly gmailLookbackDays: number;
}

/**
 * Data access for per-user preferences. A row is created lazily on first write; until then the
 * service layer falls back to the configured defaults, so reads can legitimately return undefined.
 */
export class UserPreferencesRepository {
  async findForUser(userId: string): Promise<UserPreferencesRow | undefined> {
    const row = await db
      .selectFrom('user_preferences')
      .select(['user_id', 'gmail_lookback_days'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row
      ? { userId: row.user_id, gmailLookbackDays: row.gmail_lookback_days }
      : undefined;
  }

  /** Insert-or-update the user's Gmail lookback window, stamping updated_at on conflict. */
  async upsertGmailLookbackDays(userId: string, days: number): Promise<UserPreferencesRow> {
    const row = await db
      .insertInto('user_preferences')
      .values({ user_id: userId, gmail_lookback_days: days })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ gmail_lookback_days: days, updated_at: new Date() }),
      )
      .returning(['user_id', 'gmail_lookback_days'])
      .executeTakeFirstOrThrow();
    return { userId: row.user_id, gmailLookbackDays: row.gmail_lookback_days };
  }
}

export const userPreferencesRepository = new UserPreferencesRepository();
