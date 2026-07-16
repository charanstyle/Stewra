import { EMAIL_APPROVAL_CATEGORY, expoPushService } from '../services/expoPushService.js';

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

  it('pins the Approve/Deny category id shared verbatim with the RN client', () => {
    // If this drifts from the app's setNotificationCategoryAsync id, the action buttons silently vanish.
    expect(EMAIL_APPROVAL_CATEGORY).toBe('email_approval');
  });
});
