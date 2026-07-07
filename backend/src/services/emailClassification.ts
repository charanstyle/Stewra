/**
 * Lightweight classification of Gmail messages for the briefing/nudge engine.
 *
 * Gmail auto-applies "category" labels that reliably separate personal conversation from bulk mail:
 * promotions, social notifications, forum/list traffic, and automated updates (newsletters, receipts,
 * password resets, shipping notices). A thread whose latest inbound message carries any of these is NOT
 * a person waiting on the user's reply, so it must never become a "needs a reply" nudge — otherwise the
 * user is told to "Reply to 'Get 15% off Canva'". Personal mail lands in CATEGORY_PERSONAL (or carries
 * none of these), which this predicate leaves alone.
 */
const BULK_CATEGORY_LABELS: ReadonlySet<string> = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_FORUMS',
  'CATEGORY_UPDATES',
]);

/** True when the message's labels mark it as bulk/automated (promotional, social, forum, or updates). */
export function isBulkCategory(labelIds: ReadonlyArray<string>): boolean {
  return labelIds.some((label) => BULK_CATEGORY_LABELS.has(label));
}

/**
 * Senders you cannot actually reply to — transactional/automated addresses (password resets,
 * verification codes, receipts, delivery daemons). Gmail often files these under CATEGORY_PERSONAL, so
 * the category check alone misses them; the local-part is the reliable tell. Matched on the address's
 * local-part so `no-reply@x.com`, `noreply@x.com`, `donotreply@x.com`, `mailer-daemon@…` all count.
 */
const NO_REPLY_LOCALPART =
  /^\s*(?:"?[^"<]*"?\s*<\s*)?(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer-daemon|postmaster|bounce[+-]?\w*)@/i;

/** True when the sender address is a no-reply / automated mailbox that can't be replied to. */
export function isNoReplySender(address: string): boolean {
  return NO_REPLY_LOCALPART.test(address);
}

/**
 * Subjects that are unmistakably transactional — a one-time code, verification, or password reset. These
 * arrive from ordinary-looking addresses (so the no-reply and category checks miss them) but are never a
 * conversation the user replies to. Kept deliberately narrow/high-precision so it can't swallow a real
 * thread that merely mentions a "code".
 */
const TRANSACTIONAL_SUBJECT =
  /\b(?:verification code|verify (?:your )?(?:email|account|code)|one[-\s]?time (?:pass)?code|security code|otp|confirm your (?:email|account)|password reset|reset your password)\b/i;

/** True when the subject marks the message as a transactional code/verification, not a conversation. */
export function isTransactionalSubject(subject: string): boolean {
  return TRANSACTIONAL_SUBJECT.test(subject);
}

/**
 * The single question the nudge engine actually asks: is this a message a PERSON is waiting on the user
 * to reply to? It must be inbound, not bulk/automated by category, and not from a no-reply mailbox. A
 * null sender (address unknown) is treated as replyable — we don't drop a genuine thread for lack of data.
 */
export function isReplyableInbound(
  direction: 'inbound' | 'outbound',
  labelIds: ReadonlyArray<string>,
  senderAddress: string | null,
  subject: string,
): boolean {
  if (direction !== 'inbound') {
    return false;
  }
  if (isBulkCategory(labelIds)) {
    return false;
  }
  if (senderAddress !== null && isNoReplySender(senderAddress)) {
    return false;
  }
  if (isTransactionalSubject(subject)) {
    return false;
  }
  return true;
}
