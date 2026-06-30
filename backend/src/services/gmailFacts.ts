/**
 * Pure, deterministic extraction of DERIVED FACTS from a minimized view of recent emails. Like
 * `calendarFacts`, this is the only thing the broker surfaces to the agent — short strings, never
 * raw email bodies, recipients, or full headers. Pure (emails + `now` in, fact strings out) so it
 * is unit-testable with no network.
 */

/** A minimized email — already stripped of body, to/cc, attachments, and most headers. */
export interface EmailSummary {
  readonly subject: string;
  /** The sender's display string (e.g. "Acme Billing <billing@acme.com>"). */
  readonly from: string;
  readonly unread: boolean;
  /** ISO timestamp the email was received. */
  readonly date: string;
}

/** Subject keywords that suggest a bill, receipt, or subscription — the money/time overlap. */
const BILL_KEYWORDS = [
  'invoice',
  'receipt',
  'payment',
  'bill',
  'due',
  'subscription',
  'renew',
  'past due',
  'overdue',
];

/** Pull a readable sender name out of a "Name <addr>" header, falling back to the address. */
function senderName(from: string): string {
  const angle = from.indexOf('<');
  const name = angle > 0 ? from.slice(0, angle).trim().replace(/^"|"$/g, '') : from.trim();
  return name.length > 0 ? name : from.trim();
}

export function extractGmailFacts(emails: ReadonlyArray<EmailSummary>, _now: Date): string[] {
  const facts: string[] = [];

  const unread = emails.filter((e) => e.unread);
  if (unread.length > 0) {
    facts.push(`You have ${unread.length} unread email${unread.length === 1 ? '' : 's'}`);
  }

  const billSenders = new Set<string>();
  for (const email of emails) {
    const subject = email.subject.toLowerCase();
    if (BILL_KEYWORDS.some((kw) => subject.includes(kw))) {
      billSenders.add(senderName(email.from));
    }
  }
  for (const sender of billSenders) {
    facts.push(`An email from ${sender} looks like a bill or subscription`);
  }

  return facts;
}
