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
