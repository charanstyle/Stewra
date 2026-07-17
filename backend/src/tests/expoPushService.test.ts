import { EMAIL_APPROVAL_ANDROID_CHANNEL_ID, EMAIL_APPROVAL_CATEGORY } from '@stewra/shared-types';
import { buildEmailApprovalMessage, expoPushService } from '../services/expoPushService.js';
import type { PushToken } from '../repositories/pushTokenRepository.js';

/**
 * Fail-safe contract for the Expo push sender. NO mocks: this runs the real service against the real
 * (unconfigured) config — `EXPO_ACCESS_TOKEN` is unset, which is the ONLY state the required-when-enabled
 * config guard permits while the feature is off. In that state the service must be disabled and every
 * send a silent no-op: it must never throw into the WhatsApp turn that fires it, and it must not reach the
 * database (the disabled branch returns before any query). The live smoke covers the configured/delivery
 * path against a real device — a prod-Postgres-hitting unit test would be the wrong tool here.
 */
describe('expoPushService — fail-safe when unconfigured', () => {
  it('is disabled when no Expo access token is configured', () => {
    expect(expoPushService.enabled).toBe(false);
  });

  it('no-ops (resolves, never throws) when disabled', async () => {
    await expect(
      expoPushService.sendEmailApprovalPrompt('00000000-0000-0000-0000-000000000000', {
        messageId: '11111111-1111-1111-1111-111111111111',
      }),
    ).resolves.toBeUndefined();
  });

  it('pins the Approve/Deny category id the sender and the RN client share', () => {
    // The id now lives in @stewra/shared-types, so both sides import the same constant and CANNOT drift.
    // This pins its literal value instead: the id is baked into notification categories already
    // registered on real devices, so changing it silently strips the action buttons from any
    // notification sent to an app build that registered the old one.
    expect(EMAIL_APPROVAL_CATEGORY).toBe('email_approval');
  });
});

describe('buildEmailApprovalMessage — the action-button contract', () => {
  const token: PushToken = {
    userId: '00000000-0000-0000-0000-000000000000',
    platform: 'android',
    expoToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  };
  const message = buildEmailApprovalMessage(token, { messageId: 'msg-1' });

  it('carries the category id INSIDE data — the only place expo-notifications reads it on Android', () => {
    // The bug this pins: with the id only in the top-level `categoryId` field, Expo's push service did
    // not surface it in the Android FCM data map, so the receiver resolved a null category and dropped
    // the Approve/Deny buttons with no error. The Android receiver reads `data.categoryId`, so the id
    // MUST be here for the buttons to render.
    expect((message.data as Record<string, unknown>)['categoryId']).toBe(EMAIL_APPROVAL_CATEGORY);
  });

  it('still sets the top-level categoryId (iOS) and the private Android channel', () => {
    expect(message.categoryId).toBe(EMAIL_APPROVAL_CATEGORY);
    expect(message.channelId).toBe(EMAIL_APPROVAL_ANDROID_CHANNEL_ID);
  });

  it('carries the message id and NO email contents (lock-screen safe)', () => {
    const data = message.data as Record<string, unknown>;
    expect(data['messageId']).toBe('msg-1');
    const serialized = JSON.stringify(message);
    // Generic body only — no recipient/subject/body could ride along to a lock-screen preview.
    expect(message.body).toBe('Stewra drafted an email for you to review and send.');
    expect(serialized).not.toContain('@'); // no email address leaked into the payload
  });
});
