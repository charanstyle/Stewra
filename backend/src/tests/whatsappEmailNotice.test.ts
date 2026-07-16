import {
  EMAIL_DRAFT_NOTICE,
  EMAIL_PENDING_APPROVAL_NOTICE,
  renderWhatsappEmailReply,
} from '../services/whatsappEmailNotice.js';

/**
 * The WhatsApp email-notice copy is a SECURITY control, so it is pinned here with real inputs — no mocks,
 * no DB, no LLM. `renderWhatsappEmailReply` is a pure function of (body, hasProposal, approveToSend), so
 * this suite exercises the exact behaviour both WhatsApp surfaces ship, end to end.
 *
 * The load-bearing rule under test: IRREVERSIBLE ACTIONS DO NOT HAPPEN OVER WHATSAPP. The opt-in changes
 * only the wording; whichever branch runs, the reply must never claim an email was actually sent.
 */
describe('renderWhatsappEmailReply (the WhatsApp email-draft copy gate)', () => {
  const BODY = 'Here is the draft to Sam about Friday.';

  it('leaves the body untouched when there is no email proposal', () => {
    // With nothing to send, the opt-in is irrelevant and no notice is appended either way.
    expect(renderWhatsappEmailReply(BODY, false, false)).toBe(BODY);
    expect(renderWhatsappEmailReply(BODY, false, true)).toBe(BODY);
  });

  it('opt-in OFF: appends the draft-and-defer refusal and states it will not send from WhatsApp', () => {
    const out = renderWhatsappEmailReply(BODY, true, false);
    expect(out).toBe(`${BODY}${EMAIL_DRAFT_NOTICE}`);
    expect(out).toContain('open Stewra to review and send');
    expect(out).toContain("I don't send email from WhatsApp");
    expect(out).not.toContain('Approve it in Stewra');
  });

  it('opt-in ON: invites approval on a strong-identity surface instead of refusing', () => {
    const out = renderWhatsappEmailReply(BODY, true, true);
    expect(out).toBe(`${BODY}${EMAIL_PENDING_APPROVAL_NOTICE}`);
    expect(out).toContain('Approve it in Stewra to send');
    expect(out).toContain("I'll only send once you approve");
    // The ON branch drops the blanket refusal — but must not swing the other way and imply a send.
    expect(out).not.toContain("I don't send email from WhatsApp");
  });

  it('NEVER claims an email was actually sent, whichever branch runs (the safety invariant)', () => {
    for (const approveToSend of [true, false]) {
      const out = renderWhatsappEmailReply(BODY, true, approveToSend).toLowerCase();
      // "I'll only send once you approve" is a future promise, not a claim of a completed send, so the
      // patterns below deliberately match only the past/perfect forms that would imply it already happened.
      expect(out).not.toMatch(/i've sent|email sent|sent the email|sent it|has been sent|message sent/);
    }
  });

  it('separates each notice from the body with a blank line so they never run together', () => {
    expect(EMAIL_DRAFT_NOTICE.startsWith('\n\n')).toBe(true);
    expect(EMAIL_PENDING_APPROVAL_NOTICE.startsWith('\n\n')).toBe(true);
  });
});
