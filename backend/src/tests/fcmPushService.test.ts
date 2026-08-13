import {
  EMAIL_APPROVAL_ANDROID_CHANNEL_ID,
  EMAIL_APPROVAL_CATEGORY,
  EMAIL_APPROVAL_PUSH_BODY,
  EMAIL_APPROVAL_PUSH_TITLE,
  SUGGESTION_ANDROID_CHANNEL_ID,
  SUGGESTION_CATEGORY,
  SUGGESTION_PUSH_BODY,
  SUGGESTION_PUSH_TITLE,
} from '@stewra/shared-types';
import {
  buildEmailApprovalData,
  buildSuggestionData,
  fcmPushService,
} from '../services/fcmPushService.js';

/**
 * The Android approval prompt is delivered as a raw FCM v1 DATA-ONLY message. When the app is
 * backgrounded, expo-notifications' native FirebaseMessagingDelegate (verified against v55.0.24 source)
 * rebuilds the notification ENTIRELY from this data map. Every key below is load-bearing:
 *   - `title` / `message` → the notification's title and body text (`NotificationData.title/message`),
 *   - `categoryId` → the Approve/Deny category (`NotificationData.categoryId`); WITHOUT it the buttons
 *     are silently dropped — the exact bug this whole change fixes,
 *   - `channelId` → the PRIVATE lock-screen channel (`FirebaseNotificationTrigger.getNotificationChannel`
 *     reads `data["channelId"]`); without it the prompt falls back to a public channel,
 *   - `body` → a JSON-object STRING parsed into the JS `content.data` the app routes on (type + id).
 * If any drift, delivery silently regresses with no error. Pinned here so that can't happen unnoticed.
 */
describe('buildEmailApprovalData — the Android data-only contract', () => {
  const data = buildEmailApprovalData({ messageId: 'msg-42' });

  it('sets title/message so the native receiver can rebuild the notification text', () => {
    expect(data['title']).toBe(EMAIL_APPROVAL_PUSH_TITLE);
    expect(data['message']).toBe(EMAIL_APPROVAL_PUSH_BODY);
  });

  it('sets categoryId at the top level — where the receiver reads the Approve/Deny id', () => {
    expect(data['categoryId']).toBe(EMAIL_APPROVAL_CATEGORY);
  });

  it('sets channelId so the prompt lands on the PRIVATE lock-screen channel', () => {
    expect(data['channelId']).toBe(EMAIL_APPROVAL_ANDROID_CHANNEL_ID);
  });

  it('puts content.data in `body` as a JSON-object string (type + messageId only)', () => {
    const parsed: unknown = JSON.parse(data['body'] ?? '');
    expect(parsed).toEqual({ type: EMAIL_APPROVAL_CATEGORY, messageId: 'msg-42' });
  });

  it('leaks no email address into the payload (lock-screen safe)', () => {
    expect(JSON.stringify(data)).not.toContain('@');
  });
});

/**
 * The nudge push rides the same data-only contract, with two deliberate differences pinned here: NO
 * `categoryId` (the nudge has no action buttons — the decision surface is the Today screen), and its
 * OWN channel (so the user can silence proactive nudges without silencing approve-to-send prompts).
 * The copy is the shared generic strings — a nudge title names a real email subject or calendar
 * event, and none of that may sit on a lock screen.
 */
describe('buildSuggestionData — the Android nudge-push contract', () => {
  const data = buildSuggestionData({ suggestionId: 'sug-7' });

  it('sets the generic title/message — never the nudge title', () => {
    expect(data['title']).toBe(SUGGESTION_PUSH_TITLE);
    expect(data['message']).toBe(SUGGESTION_PUSH_BODY);
  });

  it('has NO categoryId — a nudge push carries no action buttons', () => {
    expect(data['categoryId']).toBeUndefined();
  });

  it('lands on its own channel, separate from the approval channel', () => {
    expect(data['channelId']).toBe(SUGGESTION_ANDROID_CHANNEL_ID);
    expect(data['channelId']).not.toBe(EMAIL_APPROVAL_ANDROID_CHANNEL_ID);
  });

  it('puts content.data in `body` as a JSON-object string (type + suggestionId only)', () => {
    const parsed: unknown = JSON.parse(data['body'] ?? '');
    expect(parsed).toEqual({ type: SUGGESTION_CATEGORY, suggestionId: 'sug-7' });
  });
});

/**
 * Fail-safe contract, NO mocks: with `FCM_SERVICE_ACCOUNT_JSON` unset the service is disabled and every
 * send is a no-op returning no dead tokens. It must never throw into the WhatsApp turn that fires it, and
 * must reach neither the network nor the database. The configured/delivery path is covered by live smoke
 * against a real device.
 */
describe('fcmPushService — fail-safe when unconfigured', () => {
  it('is disabled when no FCM service account is configured', () => {
    expect(fcmPushService.enabled).toBe(false);
  });

  it('no-ops (resolves to no dead tokens, never throws) when disabled', async () => {
    await expect(
      fcmPushService.sendEmailApproval(['fcm-device-token-abc'], { messageId: 'msg-1' }),
    ).resolves.toEqual([]);
  });
});
