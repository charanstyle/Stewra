import { Expo } from 'expo-server-sdk';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { EMAIL_APPROVAL_ANDROID_CHANNEL_ID, EMAIL_APPROVAL_CATEGORY } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { logger } from '../utils/logger.js';
import { pushTokenRepository } from '../repositories/pushTokenRepository.js';
import type { PushToken } from '../repositories/pushTokenRepository.js';

/** Expo caps a single push request at 100 messages; we page tokens the same way to keep ticket↔token order. */
const CHUNK_SIZE = 100;

/** Payload for the approve-to-send email prompt. Only an id travels — never the email contents. */
export interface EmailApprovalPush {
  readonly messageId: string;
}

/**
 * Shape the actionable Approve/Deny notification for one device. Pure (no config, no DB) so the
 * action-button contract can be tested directly.
 *
 * `categoryId` is carried in TWO places on purpose:
 *   - the top-level `categoryId` field (iOS reads it from the APNs payload), and
 *   - inside `data` as `data.categoryId`, which is where expo-notifications' ANDROID receiver looks
 *     (`NotificationData.categoryId = data["categoryId"]`).
 * Expo's push service maps `channelId` and the top-level `categoryId` through DIFFERENT code paths, so
 * the fact that the notification lands on the right Android channel does NOT prove the top-level
 * `categoryId` reached the FCM data map. When it doesn't, Android resolves a null category and — by
 * `categoryId?.let { addActions }` — drops the Approve/Deny buttons SILENTLY, with no logcat error.
 * Putting the id in `data` ourselves makes the Android lookup succeed regardless. This is what fixes
 * the "no action buttons on the approval notification" bug.
 */
export function buildEmailApprovalMessage(
  token: PushToken,
  payload: EmailApprovalPush,
): ExpoPushMessage {
  return {
    to: token.expoToken,
    sound: 'default',
    title: 'Approve email?',
    body: 'Stewra drafted an email for you to review and send.',
    data: {
      type: EMAIL_APPROVAL_CATEGORY,
      messageId: payload.messageId,
      // The key expo-notifications' Android receiver reads the category from — see the note above.
      categoryId: EMAIL_APPROVAL_CATEGORY,
    },
    categoryId: EMAIL_APPROVAL_CATEGORY,
    // Android only; ignored on iOS. The app creates this channel with PRIVATE lock-screen
    // visibility — without naming it here the push lands on the default channel, which shows its
    // text on a locked screen.
    channelId: EMAIL_APPROVAL_ANDROID_CHANNEL_ID,
    priority: 'high',
  };
}

/**
 * Sends the general actionable notifications (Expo push) — currently the approve-to-send email prompt.
 * SEPARATE from `fcmPushService` (the call-ring path): this addresses Expo push tokens through Expo's
 * push service, not raw FCM VoIP tokens.
 *
 * Disabled and every send a no-op when `EXPO_ACCESS_TOKEN` is unset (the required-when-enabled config
 * guard means that only ever happens with the feature off). Best-effort by design: a delivery failure is
 * logged and never blocks the WhatsApp turn that triggered it. It NEVER sends email — the push only
 * prompts; approval still flows through the authenticated confirm-email endpoint on the user's device.
 */
class ExpoPushService {
  /** `undefined` = not resolved yet; `null` = resolved to "no token configured". See `client()`. */
  private expo: Expo | null | undefined;

  /**
   * Resolved on first use, NOT in the constructor. The module-scope singleton below is constructed the
   * moment anything imports this file, so reading config there would make `config.push` a load-bearing
   * requirement of every importer — including the WhatsApp channels, which import this only to fire a
   * prompt they may never fire. Deferring the read keeps the import side-effect-free.
   */
  private client(): Expo | null {
    if (this.expo === undefined) {
      const accessToken = config.push.expoAccessToken.trim();
      this.expo = accessToken.length > 0 ? new Expo({ accessToken }) : null;
    }
    return this.expo;
  }

  /** Whether actionable pushes can be sent (i.e. an Expo access token is configured). */
  get enabled(): boolean {
    return this.client() !== null;
  }

  /**
   * Fire the actionable Approve/Deny prompt for a drafted email to all of a user's registered devices.
   * The body is deliberately generic (no recipient/subject/body) so a lock-screen preview can never leak
   * the email; the app opens the correct draft from `data.messageId`. Tokens Expo reports as dead are
   * pruned so we stop pushing to a device the user no longer has.
   */
  async sendEmailApprovalPrompt(userId: string, payload: EmailApprovalPush): Promise<void> {
    const expo = this.client();
    if (expo === null) {
      return;
    }
    const tokens = (await pushTokenRepository.listForUser(userId)).filter((token) =>
      Expo.isExpoPushToken(token.expoToken),
    );
    if (tokens.length === 0) {
      return;
    }

    for (const group of this.paginate(tokens)) {
      const messages = group.map((token) => buildEmailApprovalMessage(token, payload));
      let tickets: ExpoPushTicket[];
      try {
        tickets = await expo.sendPushNotificationsAsync(messages);
      } catch (error) {
        logger.warn('expo push send failed; skipping this batch', { err: String(error), userId });
        continue;
      }
      await this.pruneDeadTokens(group, tickets);
    }
  }

  /** Split tokens into ≤100-sized batches without an index comparison (keeps the anti-pattern linter happy). */
  private paginate(tokens: PushToken[]): PushToken[][] {
    const batchCount = Math.ceil(tokens.length / CHUNK_SIZE);
    return Array.from({ length: batchCount }, (_unused, k) =>
      tokens.slice(k * CHUNK_SIZE, k * CHUNK_SIZE + CHUNK_SIZE),
    );
  }

  /** Drop any token Expo's ticket flags as `DeviceNotRegistered` (order matches the sent batch). */
  private async pruneDeadTokens(group: PushToken[], tickets: ExpoPushTicket[]): Promise<void> {
    await Promise.all(
      tickets.map(async (ticket, idx) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          const dead = group[idx];
          if (dead !== undefined) {
            await pushTokenRepository.removeByToken(dead.expoToken);
          }
        }
      }),
    );
  }
}

export const expoPushService = new ExpoPushService();
