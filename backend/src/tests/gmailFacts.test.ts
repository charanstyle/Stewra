import { extractGmailFacts, type EmailSummary } from '../services/gmailFacts';

/** Pure unit tests — no DB, no network. Email summaries in, derived fact strings out. */

const NOW = new Date(2025, 5, 30, 9, 0, 0);

function email(partial: Partial<EmailSummary>): EmailSummary {
  return {
    subject: partial.subject ?? '',
    from: partial.from ?? 'someone@example.com',
    unread: partial.unread ?? false,
    date: partial.date ?? '2025-06-30T08:00:00Z',
  };
}

describe('extractGmailFacts', () => {
  it('counts unread emails (with correct pluralization)', () => {
    const oneFact = extractGmailFacts([email({ unread: true })], NOW);
    expect(oneFact).toContain('You have 1 unread email');

    const manyFacts = extractGmailFacts(
      [email({ unread: true }), email({ unread: true }), email({ unread: false })],
      NOW,
    );
    expect(manyFacts).toContain('You have 2 unread emails');
  });

  it('detects a bill/subscription from the subject and names the sender', () => {
    const facts = extractGmailFacts(
      [email({ subject: 'Your invoice is due', from: 'Acme Billing <billing@acme.com>' })],
      NOW,
    );
    expect(facts.some((f) => f.includes('Acme Billing') && f.includes('bill'))).toBe(true);
  });

  it('returns no facts when there is nothing notable', () => {
    const facts = extractGmailFacts([email({ subject: 'lunch?', unread: false })], NOW);
    expect(facts).toEqual([]);
  });
});
