/**
 * The two things Stewra says on WhatsApp when a reply carries a confirm-gated email DRAFT, and the single
 * rule for choosing between them. This lives in its own dependency-free module for two reasons:
 *
 *  1. The wording IS a security control, so it is pinned by tests rather than left to drift. Both WhatsApp
 *     surfaces — the official channel and the experimental companion bridge — render identical copy, so
 *     the copy and the choice belong in one place, not duplicated per channel.
 *  2. IRREVERSIBLE ACTIONS DO NOT HAPPEN OVER WHATSAPP. Neither string below ever claims that an email was
 *     sent, because nothing on the WhatsApp transport can send one: the draft rides on the message as a
 *     `pending` proposal, and the actual send only ever happens through the authenticated confirm path on
 *     a strong-identity surface. The opt-in changes the WORDING, never the mechanism.
 */

/**
 * opt-in OFF (the product default): the historical draft-and-defer refusal. Says the draft exists and
 * sends the user to the app, and states plainly that this channel does not send email.
 */
export const EMAIL_DRAFT_NOTICE =
  "\n\nI've drafted that email — open Stewra to review and send it. (For your safety, I don't send email from WhatsApp.)";

/**
 * opt-in ON: invite approval. The send still does not happen here — the user approves the `pending` draft
 * on their strong-identity surface (the app, or a notification they unlock). This channel only asks.
 */
export const EMAIL_PENDING_APPROVAL_NOTICE =
  "\n\nI've drafted that email. Approve it in Stewra to send — I'll only send once you approve.";

/**
 * Compose a WhatsApp reply body with the correct email notice appended.
 *
 * @param body          the assistant's reply text (already resolved to a non-null string by the caller)
 * @param hasProposal   whether the reply carries a `pending` email proposal
 * @param approveToSend the user's approve-to-send opt-in — only consulted when `hasProposal` is true
 */
export function renderWhatsappEmailReply(
  body: string,
  hasProposal: boolean,
  approveToSend: boolean,
): string {
  if (!hasProposal) return body;
  return `${body}${approveToSend ? EMAIL_PENDING_APPROVAL_NOTICE : EMAIL_DRAFT_NOTICE}`;
}
