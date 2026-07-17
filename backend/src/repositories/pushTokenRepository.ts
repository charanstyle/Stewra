import type { PushPlatform } from '@stewra/shared-types';
import { db } from '../database/index.js';

/**
 * A stored device token for the general actionable-notification channel. Exactly one of the two token
 * fields is set per row (the table CHECK enforces at-least-one): Android registers `fcmToken` (a raw FCM
 * device token, so the approval prompt can be sent data-only and render action buttons backgrounded),
 * iOS registers `expoToken`.
 */
export interface PushToken {
  readonly userId: string;
  readonly platform: PushPlatform;
  readonly expoToken: string | null;
  readonly fcmToken: string | null;
}

interface PushTokenRow {
  readonly user_id: string;
  readonly platform: PushPlatform;
  readonly expo_token: string | null;
  readonly fcm_token: string | null;
}

const COLUMNS = ['user_id', 'platform', 'expo_token', 'fcm_token'] as const;

function toToken(row: PushTokenRow): PushToken {
  return {
    userId: row.user_id,
    platform: row.platform,
    expoToken: row.expo_token,
    fcmToken: row.fcm_token,
  };
}

export class PushTokenRepository {
  /**
   * Register (or refresh) a device's push token. One row per `(user, platform)`: a re-register from the
   * same platform overwrites the previous token, so a reinstalled/rotated device never leaves a stale
   * token that would push to a device the user no longer has. Both token columns are written on every
   * upsert (one of them null), so switching a platform's token type also clears the stale one.
   */
  async upsert(input: {
    userId: string;
    platform: PushPlatform;
    expoToken: string | null;
    fcmToken: string | null;
  }): Promise<void> {
    await db
      .insertInto('push_tokens')
      .values({
        user_id: input.userId,
        platform: input.platform,
        expo_token: input.expoToken,
        fcm_token: input.fcmToken,
      })
      .onConflict((oc) =>
        oc.columns(['user_id', 'platform']).doUpdateSet({
          expo_token: input.expoToken,
          fcm_token: input.fcmToken,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  /** All registered tokens for a user (across their platforms). */
  async listForUser(userId: string): Promise<PushToken[]> {
    const rows = await db
      .selectFrom('push_tokens')
      .select(COLUMNS)
      .where('user_id', '=', userId)
      .execute();
    return rows.map(toToken);
  }

  /** Drop an Expo token the push service reported as no longer registered, so we stop pushing to it. */
  async removeByExpoToken(expoToken: string): Promise<void> {
    await db.deleteFrom('push_tokens').where('expo_token', '=', expoToken).execute();
  }

  /** Drop an FCM device token FCM reported as UNREGISTERED, so we stop pushing to a dead device. */
  async removeByFcmToken(fcmToken: string): Promise<void> {
    await db.deleteFrom('push_tokens').where('fcm_token', '=', fcmToken).execute();
  }
}

export const pushTokenRepository = new PushTokenRepository();
