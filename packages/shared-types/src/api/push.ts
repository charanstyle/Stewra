/**
 * The GENERAL in-app push channel — Expo push notifications for actionable prompts such as the
 * approve-to-send email notification over WhatsApp.
 *
 * This is deliberately SEPARATE from the call-ring token (`RegisterCallPushTokenRequest` in `./calls`):
 * that one is a PushKit/FCM VoIP token owned by the native call layer, a different token type on a
 * different delivery path. An Expo push token (`getExpoPushTokenAsync`) is what Expo's push service
 * addresses, and it is what this contract registers.
 */

/** Platform for an Expo push token. Android ships first; iOS is a later, credentials-only add. */
export type PushPlatform = 'ios' | 'android';

/**
 * Register this device's Expo push token. One token per `(user, platform)` server-side; re-registering
 * refreshes it (a device that reinstalls or rotates its token simply overwrites the prior row).
 */
export interface RegisterPushTokenRequest {
  readonly platform: PushPlatform;
  /** The Expo push token from `getExpoPushTokenAsync`, e.g. `ExponentPushToken[xxxxxxxx]`. */
  readonly expoPushToken: string;
}

export interface RegisterPushTokenResponse {
  readonly registered: true;
}
