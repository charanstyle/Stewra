import type { CallPushPlatform } from '@stewra/shared-types';
import { db } from '../database/index';

/** A stored background-ring push token: a PushKit VoIP token (iOS) or an FCM token (Android). */
export interface CallPushToken {
  readonly userId: string;
  readonly platform: CallPushPlatform;
  readonly voipToken: string | null;
  readonly fcmToken: string | null;
}

interface CallPushTokenRow {
  readonly user_id: string;
  readonly platform: CallPushPlatform;
  readonly voip_token: string | null;
  readonly fcm_token: string | null;
}

const COLUMNS = ['user_id', 'platform', 'voip_token', 'fcm_token'] as const;

function toToken(row: CallPushTokenRow): CallPushToken {
  return {
    userId: row.user_id,
    platform: row.platform,
    voipToken: row.voip_token,
    fcmToken: row.fcm_token,
  };
}

export class CallPushTokenRepository {
  /**
   * Register (or refresh) a device's ring token. One row per `(user, platform)`: a re-register from the
   * same platform overwrites the previous token so a reinstalled/rotated device never leaves a stale
   * token that would ring a phone the user no longer has.
   */
  async upsert(input: {
    userId: string;
    platform: CallPushPlatform;
    voipToken: string | null;
    fcmToken: string | null;
  }): Promise<void> {
    await db
      .insertInto('call_push_tokens')
      .values({
        user_id: input.userId,
        platform: input.platform,
        voip_token: input.voipToken,
        fcm_token: input.fcmToken,
      })
      .onConflict((oc) =>
        oc.columns(['user_id', 'platform']).doUpdateSet({
          voip_token: input.voipToken,
          fcm_token: input.fcmToken,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  /** All registered ring tokens for a user (across their platforms). */
  async listForUser(userId: string): Promise<CallPushToken[]> {
    const rows = await db
      .selectFrom('call_push_tokens')
      .select(COLUMNS)
      .where('user_id', '=', userId)
      .execute();
    return rows.map(toToken);
  }
}

export const callPushTokenRepository = new CallPushTokenRepository();
