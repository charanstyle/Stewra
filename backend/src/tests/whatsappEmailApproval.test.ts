import { resolveApproveToSend } from '../services/whatsappEmailApprovalService.js';
import { renderWhatsappEmailReply } from '../services/whatsappEmailNotice.js';

/**
 * The kill-switch contract for approve-to-send email over WhatsApp. NO mocks: `resolveApproveToSend` and
 * `renderWhatsappEmailReply` are both pure, so the rule and the user-visible consequence of the rule are
 * testable exactly as they ship — no config stub, no database, nothing that could drift from production.
 *
 * The pairing is the point. `resolveApproveToSend` is the single condition that gates BOTH effects of the
 * opt-in in the two WhatsApp channels: which notice the user reads, and whether the approval push fires.
 * Asserting the rule and then feeding its result to the real renderer covers both without reaching for
 * the mock-heavy channel suites. `isActiveFor`'s database read is deliberately left to the live smoke.
 */

const BODY = 'Drafted your note to Sam.';

describe('resolveApproveToSend — two independent switches, both required', () => {
  it('is live only when the kill-switch and the opt-in are both on', () => {
    expect(resolveApproveToSend(true, true)).toBe(true);
  });

  it('is off when the user has not opted in, however the kill-switch is set', () => {
    expect(resolveApproveToSend(true, false)).toBe(false);
    expect(resolveApproveToSend(false, false)).toBe(false);
  });

  it('is off for an ALREADY opted-in user once the kill-switch goes off', () => {
    // The regression this whole gate exists for. The switch is our only way to retract the feature in
    // prod without a deploy, and the users it must protect are exactly the ones who already opted in —
    // so a switch that only blocked new opt-ins would protect nobody.
    expect(resolveApproveToSend(false, true)).toBe(false);
  });
});

describe('the kill-switch reaches what the user actually sees', () => {
  it('offers approval only with the feature switched on and opted in', () => {
    const reply = renderWhatsappEmailReply(BODY, true, resolveApproveToSend(true, true));
    expect(reply).toContain('Approve it in Stewra');
    expect(reply).not.toContain("I don't send email from WhatsApp");
  });

  it('falls back to draft-and-defer when the kill-switch retracts an opted-in user', () => {
    // Switch off + opt-in on: the user must read the historical refusal, not an invitation to approve
    // something no longer wired to a push.
    const reply = renderWhatsappEmailReply(BODY, true, resolveApproveToSend(false, true));
    expect(reply).toContain("I don't send email from WhatsApp");
    expect(reply).not.toContain('Approve it in Stewra');
  });

  it('leaves a reply with no draft untouched in every switch combination', () => {
    for (const killSwitch of [true, false]) {
      for (const optedIn of [true, false]) {
        expect(renderWhatsappEmailReply(BODY, false, resolveApproveToSend(killSwitch, optedIn))).toBe(
          BODY,
        );
      }
    }
  });
});

describe('the push fires on exactly the same condition as the wording', () => {
  it('gates the Approve/Deny push off for an opted-in user when the switch is off', () => {
    // Both channels guard the push with `if (approveToSend)`, where `approveToSend` is this rule's
    // result — so this false is what stops the push. If the push is ever gated on the bare preference
    // again, that divergence is the bug; this asserts the one value both effects share.
    const approveToSend = resolveApproveToSend(false, true);
    expect(approveToSend).toBe(false);
    expect(renderWhatsappEmailReply(BODY, true, approveToSend)).toContain(
      "I don't send email from WhatsApp",
    );
  });
});
