import type { PushPlatform } from '@stewra/shared-types';
import { pushTokenRepository } from '../repositories/pushTokenRepository.js';

/**
 * Owns the general Expo push-token registration used by actionable notifications (e.g. approve-to-send
 * email over WhatsApp). Registration is capability-free — it only records where a user's devices can be
 * reached; nothing here decides whether or what to send. The sender lives in `expoPushService`.
 */
class PushTokenService {
  /** Register/refresh this device's Expo push token (one per user+platform; re-register overwrites). */
  async register(userId: string, input: { platform: PushPlatform; expoPushToken: string }): Promise<void> {
    await pushTokenRepository.upsert({
      userId,
      platform: input.platform,
      expoToken: input.expoPushToken,
    });
  }
}

export const pushTokenService = new PushTokenService();
