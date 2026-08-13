import { describe, expect, it } from 'vitest';
import {
  extractMoneyFacts,
  type MoneyAccountSnapshot,
  type MoneyTransactionView,
} from '../services/moneyFacts.js';

/**
 * The money fact extractor is PURE — accounts + transactions + `now` in, short strings out — and
 * these tests pin the three derivations the plan names (low-balance projection, unusual charge,
 * subscription creep) plus the refusals that make them honest: no history → no projection, mixed
 * currencies → no invented single total, and nothing resembling a raw record in any fact.
 */

const NOW = new Date('2026-08-13T12:00:00');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD for `days` before NOW. */
function daysAgo(days: number): string {
  const d = new Date(NOW.getTime() - days * MS_PER_DAY);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function checking(availableMicros: bigint): MoneyAccountSnapshot {
  return {
    name: 'Everyday Checking',
    accountType: 'depository',
    isoCurrencyCode: 'USD',
    availableMicros,
    currentMicros: availableMicros,
  };
}

function charge(
  merchant: string,
  amountUnits: number,
  postedDaysAgo: number,
  overrides: Partial<MoneyTransactionView> = {},
): MoneyTransactionView {
  return {
    merchant,
    amountMicros: BigInt(Math.round(amountUnits * 1_000_000)),
    isoCurrencyCode: 'USD',
    postedAt: daysAgo(postedDaysAgo),
    pending: false,
    ...overrides,
  };
}

describe('low-balance projection', () => {
  it('projects runway from the recent spending pace when it is short', () => {
    // 450 USD out over the last 30 days = 15/day; 60 USD in the bank = 4 days of runway.
    const spending = [
      charge('Grocer', 90, 25),
      charge('Grocer', 90, 18),
      charge('Grocer', 90, 12),
      charge('Grocer', 90, 8),
      charge('Grocer', 90, 2),
    ];
    const facts = extractMoneyFacts([checking(60_000_000n)], spending, NOW);
    const runway = facts.find((f) => f.includes('covers roughly'));
    expect(runway).toBeDefined();
    expect(runway).toContain('15.00 USD/day');
    expect(runway).toContain('60.00 USD');
    expect(runway).toContain('4 more days');
  });

  it('stays silent with a comfortable balance, and never counts a credit-card balance as spendable', () => {
    const spending = [charge('Grocer', 90, 10)];
    const comfortable = extractMoneyFacts([checking(5_000_000_000n)], spending, NOW);
    expect(comfortable.find((f) => f.includes('covers roughly'))).toBeUndefined();

    // A credit account's "balance" is debt — even a huge one must not create spendable runway.
    const credit: MoneyAccountSnapshot = {
      name: 'Rewards Card',
      accountType: 'credit',
      isoCurrencyCode: 'USD',
      availableMicros: 9_000_000_000n,
      currentMicros: 9_000_000_000n,
    };
    const creditOnly = extractMoneyFacts([credit], spending, NOW);
    expect(creditOnly.find((f) => f.includes('covers roughly'))).toBeUndefined();
  });

  it('projects nothing when there is no spending history — a guess is not a fact', () => {
    const facts = extractMoneyFacts([checking(1_000_000n)], [], NOW);
    expect(facts).toEqual([]);
  });
});

describe('unusual charge', () => {
  const baseline = [
    charge('Grocer', 20, 60),
    charge('Grocer', 22, 45),
    charge('Grocer', 18, 30),
    charge('Grocer', 21, 15),
  ];

  it('flags a recent charge far above the typical one', () => {
    const facts = extractMoneyFacts([], [...baseline, charge('Jetstore', 400, 3)], NOW);
    const unusual = facts.find((f) => f.includes('much larger than your typical charge'));
    expect(unusual).toBeDefined();
    expect(unusual).toContain('400.00 USD');
    expect(unusual).toContain('Jetstore');
  });

  it('does not flag small spikes (the floor) or anything without history to compare against', () => {
    // 45 is 2–3× the ~20 median but under the 50-unit floor.
    const smallSpike = extractMoneyFacts([], [...baseline, charge('Cafe', 45, 2)], NOW);
    expect(smallSpike.find((f) => f.includes('much larger'))).toBeUndefined();

    // A big first-ever charge has no baseline; silence is the only honest output.
    const noHistory = extractMoneyFacts([], [charge('Jetstore', 400, 3)], NOW);
    expect(noHistory.find((f) => f.includes('much larger'))).toBeUndefined();
  });
});

describe('subscription creep', () => {
  const streamly = [
    charge('Streamly', 12.99, 65),
    charge('Streamly', 12.99, 35),
    charge('Streamly', 15.99, 5),
  ];

  it('recognizes a monthly merchant and reports a price that has risen', () => {
    const facts = extractMoneyFacts([], streamly, NOW);
    const creep = facts.find((f) => f.includes('has risen'));
    expect(creep).toBeDefined();
    expect(creep).toContain('Streamly');
    expect(creep).toContain('12.99 USD');
    expect(creep).toContain('15.99 USD');
    expect(
      facts.find((f) => f.includes('1 recurring monthly charge') && f.includes('15.99 USD/month')),
    ).toBeDefined();
  });

  it('does not call irregular spending a subscription', () => {
    const irregular = [
      charge('Grocer', 30, 50),
      charge('Grocer', 30, 47),
      charge('Grocer', 30, 3),
    ];
    const facts = extractMoneyFacts([], irregular, NOW);
    expect(facts.find((f) => f.includes('recurring'))).toBeUndefined();
  });

  it('counts recurring charges across currencies without inventing a single total', () => {
    const twoCurrencies = [
      ...streamly,
      charge('Musiq', 9.99, 64, { isoCurrencyCode: 'EUR' }),
      charge('Musiq', 9.99, 34, { isoCurrencyCode: 'EUR' }),
      charge('Musiq', 9.99, 4, { isoCurrencyCode: 'EUR' }),
    ];
    const facts = extractMoneyFacts([], twoCurrencies, NOW);
    expect(
      facts.find((f) => f.includes('2 recurring monthly charges across multiple currencies')),
    ).toBeDefined();
    expect(facts.find((f) => f.includes('/month') && f.includes('total'))).toBeUndefined();
  });
});
