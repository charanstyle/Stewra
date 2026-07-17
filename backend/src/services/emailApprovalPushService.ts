import { pushTokenRepository } from '../repositories/pushTokenRepository.js';
import { expoPushService } from './expoPushService.js';
import type { EmailApprovalPush } from './expoPushService.js';
import { fcmPushService } from './fcmPushService.js';

/**
 * Coordinates the approve-to-send email prompt across a user's devices. Each platform is delivered by a
 * DIFFERENT transport, because a backgrounded actionable notification requires different things on each:
 *   - Android → raw FCM v1 DATA-ONLY (`fcmPushService`). Only a data-only message runs
 *     expo-notifications' receiver when backgrounded, which is what attaches the Approve/Deny buttons;
 *     Expo's push service always delivers notification-type on Android, so it can't be used here.
 *   - iOS → Expo push (`expoPushService`), which forwards to APNs with the actionable category.
 *
 * This is the single entry point the WhatsApp channels fire. It lists a user's tokens once, routes each
 * to its transport, and prunes any the transport reports as permanently gone.
 *
 * ⚠️ It NEVER sends the email. The push is only a prompt: approval always flows through the
 * authenticated `POST /messages/:id/confirm-email` on the user's signed-in device. Send authority is the
 * app session, never the WhatsApp identity or the notification.
 */
class EmailApprovalPushService {
  /** Fire the Approve/Deny prompt to every device a user has registered. Best-effort; never throws. */
  async send(userId: string, payload: EmailApprovalPush): Promise<void> {
    const tokens = await pushTokenRepository.listForUser(userId);
    // Route by platform, not just token presence: a stale Android Expo token (from before the raw-FCM
    // switch) must NOT be sent via Expo — that would deliver notification-type with no buttons, the very
    // bug this design fixes. Each platform is delivered only by its own transport.
    const expoTokens = tokens.flatMap((token) =>
      token.platform === 'ios' && token.expoToken !== null ? [token.expoToken] : [],
    );
    const fcmTokens = tokens.flatMap((token) =>
      token.platform === 'android' && token.fcmToken !== null ? [token.fcmToken] : [],
    );

    const [deadExpo, deadFcm] = await Promise.all([
      expoPushService.sendEmailApproval(expoTokens, payload),
      fcmPushService.sendEmailApproval(fcmTokens, payload),
    ]);

    await Promise.all([
      ...deadExpo.map((token) => pushTokenRepository.removeByExpoToken(token)),
      ...deadFcm.map((token) => pushTokenRepository.removeByFcmToken(token)),
    ]);
  }
}

export const emailApprovalPushService = new EmailApprovalPushService();
