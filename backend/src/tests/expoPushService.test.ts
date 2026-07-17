import {
  EMAIL_APPROVAL_ANDROID_CHANNEL_ID,
  EMAIL_APPROVAL_CATEGORY,
  EMAIL_APPROVAL_PUSH_BODY,
} from '@stewra/shared-types';
import { buildEmailApprovalMessage, expoPushService } from '../services/expoPushService.js';

/**
 * Fail-safe contract for the iOS Expo sender. NO mocks: this runs the real service against the real
 * (unconfigured) config — `EXPO_ACCESS_TOKEN` is unset, which is the ONLY state the required-when-enabled
 * config guard permits while the feature is off. In that state the service must be disabled and every
 * send a no-op that returns no dead tokens: it must never throw into the WhatsApp turn that fires it, and
 * it must not reach the database. The live smoke covers the configured/delivery path against a real
 * device — a prod-Postgres-hitting unit test would be the wrong tool here.
 */
describe('expoPushService — fail-safe when unconfigured', () => {
  it('is disabled when no Expo access token is configured', () => {
    expect(expoPushService.enabled).toBe(false);
  });

  it('no-ops (resolves to no dead tokens, never throws) when disabled', async () => {
    await expect(
      expoPushService.sendEmailApproval(['ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'], {
        messageId: '11111111-1111-1111-1111-111111111111',
      }),
    ).resolves.toEqual([]);
  });

  it('pins the Approve/Deny category id the sender and the RN client share', () => {
    // The id lives in @stewra/shared-types, so both sides import the same constant and CANNOT drift.
    // This pins its literal value: the id is baked into notification categories already registered on
    // real devices, so changing it silently strips the action buttons.
    expect(EMAIL_APPROVAL_CATEGORY).toBe('email_approval');
  });
});

describe('buildEmailApprovalMessage — the iOS action-button contract', () => {
  const message = buildEmailApprovalMessage('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]', {
    messageId: 'msg-1',
  });

  it('carries the category id in data and at the top level, and the private Android channel', () => {
    expect((message.data as Record<string, unknown>)['categoryId']).toBe(EMAIL_APPROVAL_CATEGORY);
    expect(message.categoryId).toBe(EMAIL_APPROVAL_CATEGORY);
    expect(message.channelId).toBe(EMAIL_APPROVAL_ANDROID_CHANNEL_ID);
  });

  it('carries the message id and NO email contents (lock-screen safe)', () => {
    const data = message.data as Record<string, unknown>;
    expect(data['messageId']).toBe('msg-1');
    expect(data['type']).toBe(EMAIL_APPROVAL_CATEGORY);
    // Generic body only — no recipient/subject/body could ride along to a lock-screen preview.
    expect(message.body).toBe(EMAIL_APPROVAL_PUSH_BODY);
    expect(JSON.stringify(message)).not.toContain('@'); // no email address leaked into the payload
  });
});
