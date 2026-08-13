import { pushTokenRepository } from '../repositories/pushTokenRepository.js';
import { expoPushService } from './expoPushService.js';
import type { SuggestionPush } from './expoPushService.js';
import { fcmPushService } from './fcmPushService.js';

/**
 * Coordinates the proactive-nudge push (build-plan M4: "calendar conflict tomorrow", "low balance
 * trending") across a user's devices, exactly as `emailApprovalPushService` coordinates the approval
 * prompt: iOS via Expo, Android via raw FCM v1 data-only, dead tokens pruned. Fired only for a nudge
 * the user has never been told about — a recompute refreshing an existing nudge sends nothing, so the
 * phone buzzes once per genuinely new thing, not once per background tick.
 *
 * The push is a doorbell, not a decision surface: it carries only the suggestion id and generic copy.
 * Everything real — the nudge title, its options, the data behind it — is fetched over the app's
 * authenticated session when the user opens Today.
 */
class SuggestionPushService {
  /** Fire the nudge notification to every device a user has registered. Best-effort; never throws. */
  async send(userId: string, payload: SuggestionPush): Promise<void> {
    const tokens = await pushTokenRepository.listForUser(userId);
    // Route by platform, never by token presence — same rule as the approval push: an Android token
    // must only ever be sent raw FCM data-only, or the notification arrives without its channel.
    const expoTokens = tokens.flatMap((token) =>
      token.platform === 'ios' && token.expoToken !== null ? [token.expoToken] : [],
    );
    const fcmTokens = tokens.flatMap((token) =>
      token.platform === 'android' && token.fcmToken !== null ? [token.fcmToken] : [],
    );

    const [deadExpo, deadFcm] = await Promise.all([
      expoPushService.sendSuggestion(expoTokens, payload),
      fcmPushService.sendSuggestion(fcmTokens, payload),
    ]);

    await Promise.all([
      ...deadExpo.map((token) => pushTokenRepository.removeByExpoToken(token)),
      ...deadFcm.map((token) => pushTokenRepository.removeByFcmToken(token)),
    ]);
  }
}

export const suggestionPushService = new SuggestionPushService();
