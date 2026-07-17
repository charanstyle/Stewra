import { Expo } from 'expo-server-sdk';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import {
  EMAIL_APPROVAL_ANDROID_CHANNEL_ID,
  EMAIL_APPROVAL_CATEGORY,
  EMAIL_APPROVAL_PUSH_BODY,
  EMAIL_APPROVAL_PUSH_TITLE,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { logger } from '../utils/logger.js';

/** Expo caps a single push request at 100 messages; we page tokens the same way to keep ticket↔token order. */
const CHUNK_SIZE = 100;

/** Payload for the approve-to-send email prompt. Only an id travels — never the email contents. */
export interface EmailApprovalPush {
  readonly messageId: string;
}

/**
 * Shape the actionable Approve/Deny notification for one iOS device. Pure (no config, no DB) so the
 * action-button contract can be tested directly.
 *
 * This is the iOS path: Expo forwards to APNs, which reads the top-level `categoryId` to attach the
 * Approve/Deny actions. (Android does NOT use this path — Expo always delivers notification-type on
 * Android, so a backgrounded push there gets no buttons; Android is sent raw FCM v1 data-only instead,
 * see `fcmPushService.sendEmailApproval`.) `categoryId` is also mirrored into `data` — harmless on iOS
 * and keeps the payload identical to what the Android receiver would read, should Expo ever address it.
 */
export function buildEmailApprovalMessage(
  expoToken: string,
  payload: EmailApprovalPush,
): ExpoPushMessage {
  return {
    to: expoToken,
    sound: 'default',
    title: EMAIL_APPROVAL_PUSH_TITLE,
    body: EMAIL_APPROVAL_PUSH_BODY,
    data: {
      type: EMAIL_APPROVAL_CATEGORY,
      messageId: payload.messageId,
      categoryId: EMAIL_APPROVAL_CATEGORY,
    },
    categoryId: EMAIL_APPROVAL_CATEGORY,
    channelId: EMAIL_APPROVAL_ANDROID_CHANNEL_ID,
    priority: 'high',
  };
}

/**
 * Sends the approve-to-send email prompt to iOS devices via Expo push. SEPARATE from `fcmPushService`
 * (Android raw-FCM data-only) and from the call-ring path. Coordinated by `emailApprovalPushService`,
 * which lists a user's tokens, routes each platform to its sender, and prunes the dead ones this returns.
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
   * requirement of every importer. Deferring the read keeps the import side-effect-free.
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
   * Push the Approve/Deny prompt to the given Expo push tokens (iOS), returning the tokens Expo reports
   * as `DeviceNotRegistered` so the caller can prune them. The body is deliberately generic (no
   * recipient/subject/body) so a lock-screen preview can never leak the email; the app opens the correct
   * draft from `data.messageId`.
   */
  async sendEmailApproval(expoTokens: string[], payload: EmailApprovalPush): Promise<string[]> {
    const expo = this.client();
    const tokens = expoTokens.filter((token) => Expo.isExpoPushToken(token));
    if (expo === null || tokens.length === 0) {
      return [];
    }

    const dead: string[] = [];
    for (const group of this.paginate(tokens)) {
      const messages = group.map((token) => buildEmailApprovalMessage(token, payload));
      let tickets: ExpoPushTicket[];
      try {
        tickets = await expo.sendPushNotificationsAsync(messages);
      } catch (error) {
        logger.warn('expo push send failed; skipping this batch', { err: String(error) });
        continue;
      }
      tickets.forEach((ticket, idx) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          const token = group[idx];
          if (token !== undefined) {
            dead.push(token);
          }
        }
      });
    }
    return dead;
  }

  /** Split tokens into ≤100-sized batches without an index comparison (keeps the anti-pattern linter happy). */
  private paginate(tokens: string[]): string[][] {
    const batchCount = Math.ceil(tokens.length / CHUNK_SIZE);
    return Array.from({ length: batchCount }, (_unused, k) =>
      tokens.slice(k * CHUNK_SIZE, k * CHUNK_SIZE + CHUNK_SIZE),
    );
  }
}

export const expoPushService = new ExpoPushService();
