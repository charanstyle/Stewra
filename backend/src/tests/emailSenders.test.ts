import { buildEmailSender, sendableProviders, GMAIL_PROVIDER } from '../services/emailSenders/index.js';

/**
 * The provider registry is the seam that keeps the send tool from being Gmail-only: the confirm-gated
 * executor asks it which providers can send and builds a sender by provider code. These tests pin that
 * contract (Gmail registered today; unknown providers yield null) without any network call.
 */
describe('email sender registry', () => {
  it('exposes Gmail as a sendable provider', () => {
    expect(sendableProviders()).toContain(GMAIL_PROVIDER);
  });

  it('builds a Gmail sender whose provider code matches the connection provider', () => {
    const sender = buildEmailSender(GMAIL_PROVIDER, 'refresh-token');
    expect(sender).not.toBeNull();
    expect(sender?.provider).toBe(GMAIL_PROVIDER);
  });

  it('returns null for a provider with no registered adapter', () => {
    expect(buildEmailSender('outlook', 'refresh-token')).toBeNull();
  });
});
