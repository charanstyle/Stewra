import type { RegisterPushTokenRequest } from '@stewra/shared-types';
import { pushTokenRepository } from '../repositories/pushTokenRepository.js';

/**
 * Owns the general push-token registration used by actionable notifications (e.g. approve-to-send email
 * over WhatsApp). Registration is capability-free — it only records where a user's devices can be
 * reached; nothing here decides whether or what to send. The senders live in `expoPushService` (iOS) and
 * `fcmPushService` (Android), coordinated by `emailApprovalPushService`.
 *
 * The token type is discriminated by platform: Android registers a raw FCM device token (data-only
 * delivery is the only way to a backgrounded actionable notification there), iOS an Expo push token.
 */
class PushTokenService {
  /** Register/refresh this device's push token (one per user+platform; re-register overwrites). */
  async register(userId: string, input: RegisterPushTokenRequest): Promise<void> {
    await pushTokenRepository.upsert({
      userId,
      platform: input.platform,
      expoToken: input.platform === 'ios' ? input.expoPushToken : null,
      fcmToken: input.platform === 'android' ? input.fcmToken : null,
    });
  }
}

export const pushTokenService = new PushTokenService();
