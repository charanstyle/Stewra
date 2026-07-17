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

/**
 * The notification category the approve-to-send prompt is sent under, and the ids of its two action
 * buttons. The sender sets `categoryId`; the app registers the same id via `setNotificationCategoryAsync`
 * and matches `actionIdentifier` against these when the user taps a button.
 *
 * These live here, in the contract, precisely BECAUSE both sides must agree on them character-for-
 * character: if the ids drift, the OS silently drops the buttons — no error, no crash, just a
 * notification that can't be acted on. A shared constant makes that class of drift impossible rather
 * than leaving it to a comment asking each side to remember.
 */
export const EMAIL_APPROVAL_CATEGORY = 'email_approval';
export const EMAIL_APPROVAL_ACTION_APPROVE = 'approve';
export const EMAIL_APPROVAL_ACTION_DENY = 'deny';

/**
 * The Android notification channel the approval prompt is delivered on. Same reason as the ids above:
 * the app creates the channel and the sender addresses it, so the string has to be shared or the push
 * lands on the default channel with default (public) lock-screen visibility.
 *
 * The app creates it with PRIVATE visibility, so a locked screen shows that a notification exists but
 * not its text. Defence in depth — the body is already generic and carries no email content.
 */
export const EMAIL_APPROVAL_ANDROID_CHANNEL_ID = 'email-approval';

/**
 * The `data` an approve-to-send push carries. Deliberately just an id: the notification must never carry
 * the recipient, subject, or body, because a lock-screen preview would leak the email to anyone holding
 * the phone. The app re-fetches the draft over its authenticated session using `messageId`.
 */
export interface EmailApprovalPushData {
  readonly type: typeof EMAIL_APPROVAL_CATEGORY;
  readonly messageId: string;
}
