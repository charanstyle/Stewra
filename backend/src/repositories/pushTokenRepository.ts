import type { PushPlatform } from '@stewra/shared-types';
import { db } from '../database/index.js';

/** A stored Expo push token for the general actionable-notification channel. */
export interface PushToken {
  readonly userId: string;
  readonly platform: PushPlatform;
  readonly expoToken: string;
}

interface PushTokenRow {
  readonly user_id: string;
  readonly platform: PushPlatform;
  readonly expo_token: string;
}

const COLUMNS = ['user_id', 'platform', 'expo_token'] as const;

function toToken(row: PushTokenRow): PushToken {
  return {
    userId: row.user_id,
    platform: row.platform,
    expoToken: row.expo_token,
  };
}

export class PushTokenRepository {
  /**
   * Register (or refresh) a device's Expo push token. One row per `(user, platform)`: a re-register from
   * the same platform overwrites the previous token, so a reinstalled/rotated device never leaves a stale
   * token that would send a prompt to a device the user no longer has.
   */
  async upsert(input: { userId: string; platform: PushPlatform; expoToken: string }): Promise<void> {
    await db
      .insertInto('push_tokens')
      .values({
        user_id: input.userId,
        platform: input.platform,
        expo_token: input.expoToken,
      })
      .onConflict((oc) =>
        oc.columns(['user_id', 'platform']).doUpdateSet({
          expo_token: input.expoToken,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  /** All registered Expo push tokens for a user (across their platforms). */
  async listForUser(userId: string): Promise<PushToken[]> {
    const rows = await db
      .selectFrom('push_tokens')
      .select(COLUMNS)
      .where('user_id', '=', userId)
      .execute();
    return rows.map(toToken);
  }

  /** Drop a token Expo has reported as no longer registered, so we stop pushing to a dead device. */
  async removeByToken(expoToken: string): Promise<void> {
    await db.deleteFrom('push_tokens').where('expo_token', '=', expoToken).execute();
  }
}

export const pushTokenRepository = new PushTokenRepository();
