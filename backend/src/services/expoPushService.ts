import { Expo } from 'expo-server-sdk';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { config } from '../config/unifiedConfig.js';
import { logger } from '../utils/logger.js';
import { pushTokenRepository } from '../repositories/pushTokenRepository.js';
import type { PushToken } from '../repositories/pushTokenRepository.js';

/**
 * The category id the RN app registers its Approve/Deny actions under. Shared verbatim with the client's
 * `setNotificationCategoryAsync` call — if they drift the buttons silently vanish, so keep them equal.
 */
export const EMAIL_APPROVAL_CATEGORY = 'email_approval';

/** Expo caps a single push request at 100 messages; we page tokens the same way to keep ticket↔token order. */
const CHUNK_SIZE = 100;

/** Payload for the approve-to-send email prompt. Only an id travels — never the email contents. */
export interface EmailApprovalPush {
  readonly messageId: string;
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
  private readonly expo: Expo | null;

  constructor() {
    const accessToken = config.push.expoAccessToken.trim();
    this.expo = accessToken.length > 0 ? new Expo({ accessToken }) : null;
  }

  /** Whether actionable pushes can be sent (i.e. an Expo access token is configured). */
  get enabled(): boolean {
    return this.expo !== null;
  }

  /**
   * Fire the actionable Approve/Deny prompt for a drafted email to all of a user's registered devices.
   * The body is deliberately generic (no recipient/subject/body) so a lock-screen preview can never leak
   * the email; the app opens the correct draft from `data.messageId`. Tokens Expo reports as dead are
   * pruned so we stop pushing to a device the user no longer has.
   */
  async sendEmailApprovalPrompt(userId: string, payload: EmailApprovalPush): Promise<void> {
    const expo = this.expo;
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
      const messages = group.map((token) => this.buildMessage(token, payload));
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

  /** The one place the notification is shaped — generic body only, id in `data` for the app to resolve. */
  private buildMessage(token: PushToken, payload: EmailApprovalPush): ExpoPushMessage {
    return {
      to: token.expoToken,
      sound: 'default',
      title: 'Approve email?',
      body: 'Stewra drafted an email for you to review and send.',
      data: { type: EMAIL_APPROVAL_CATEGORY, messageId: payload.messageId },
      categoryId: EMAIL_APPROVAL_CATEGORY,
      priority: 'high',
    };
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
