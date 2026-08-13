/**
 * The GENERAL in-app push channel — actionable prompts such as the approve-to-send email notification
 * over WhatsApp. Deliberately SEPARATE from the call-ring token (`RegisterCallPushTokenRequest` in
 * `./calls`), which is a PushKit/FCM VoIP token owned by the native call layer.
 *
 * The two platforms register DIFFERENT token types, on purpose (confirmed on-device 2026-07-17):
 *   - Android registers a RAW FCM device token (`getDevicePushTokenAsync`). The prompt has to arrive as
 *     a DATA-ONLY FCM message so that, when the app is backgrounded, expo-notifications' native receiver
 *     runs and attaches the Approve/Deny buttons. Expo's push service ALWAYS synthesises an FCM
 *     `notification` block on Android, so a push sent through it is delivered notification-type and the
 *     OS auto-displays it with NO action buttons. The only way to a backgrounded actionable notification
 *     is to send raw FCM v1 data-only ourselves — which needs the FCM device token, not an Expo token.
 *   - iOS registers an Expo push token (`getExpoPushTokenAsync`); Expo→APNs delivers actionable
 *     categories there. (iOS is a later, credentials-only add; the contract is ready for it.)
 */

/** Platform for a general push token. */
export type PushPlatform = 'ios' | 'android';

/**
 * Register this device for approval pushes. One token per `(user, platform)` server-side; re-registering
 * refreshes it (a reinstalled or token-rotated device simply overwrites the prior row). The token type
 * is discriminated by platform — see the note above for why Android and iOS differ.
 */
export interface RegisterAndroidPushTokenRequest {
  readonly platform: 'android';
  /** The raw FCM device registration token from `getDevicePushTokenAsync()` (`type: 'android'`). */
  readonly fcmToken: string;
}

export interface RegisterIosPushTokenRequest {
  readonly platform: 'ios';
  /** The Expo push token from `getExpoPushTokenAsync`, e.g. `ExponentPushToken[xxxxxxxx]`. */
  readonly expoPushToken: string;
}

export type RegisterPushTokenRequest =
  | RegisterAndroidPushTokenRequest
  | RegisterIosPushTokenRequest;

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

/**
 * The user-facing copy of the approval notification. Deliberately GENERIC — no recipient, subject, or
 * body — so a lock-screen preview can never leak the email. Shared here because both senders (Expo for
 * iOS, raw FCM v1 for Android) must present identical text, and the Android data-only path puts these
 * exact strings in the FCM `data` map (`title`/`message`) for expo-notifications to rebuild from.
 */
export const EMAIL_APPROVAL_PUSH_TITLE = 'Approve email?';
export const EMAIL_APPROVAL_PUSH_BODY = 'Stewra drafted an email for you to review and send.';

/**
 * The proactive source-data nudge push (build-plan M4: "calendar conflict tomorrow", "low balance
 * trending") — sent when the background recompute produces a NEW nudge, never for a refresh of one
 * the user has already been told about. No action buttons: the notification is a doorbell, the
 * decision surface is the Today screen. Same shared-constant rule as the approval category above.
 */
export const SUGGESTION_CATEGORY = 'suggestion';

/**
 * The Android channel nudge pushes are delivered on. Its own channel (not the approval one) so the
 * user can silence proactive nudges in OS settings without also silencing approve-to-send prompts —
 * the two interruptions have very different stakes. The app creates it with PRIVATE lock-screen
 * visibility, like the approval channel.
 */
export const SUGGESTION_ANDROID_CHANNEL_ID = 'suggestions';

/**
 * The `data` a nudge push carries. Deliberately just an id — never the nudge title, which names a
 * real email subject or calendar event and must not sit on a lock screen. The app re-fetches the
 * suggestion over its authenticated session.
 */
export interface SuggestionPushData {
  readonly type: typeof SUGGESTION_CATEGORY;
  readonly suggestionId: string;
}

/**
 * The user-facing copy of a nudge push. Deliberately GENERIC — the specifics live behind the app's
 * authentication, not on the lock screen — and shared so both transports present identical text.
 */
export const SUGGESTION_PUSH_TITLE = 'Stewra noticed something';
export const SUGGESTION_PUSH_BODY = 'Something may need your attention — open Today to take a look.';
