/**
 * Pure, deterministic extraction of DERIVED FACTS from stored money records. Like `calendarFacts`
 * and `gmailFacts`, this is the only thing the broker surfaces to the agent — short,
 * human-meaningful strings, never raw transactions, account numbers, or balances-as-records. Pure
 * (accounts + transactions + `now` in, fact strings out) so it is unit-testable with no network.
 *
 * All amounts are bigint MICROS. Facts are informational observations about the user's own data —
 * never advice — and the three derivations are exactly the plan's: low-balance projection, unusual
 * charge, subscription creep.
 */

/** A minimized account snapshot — name, type, and current balances, nothing else. */
export interface MoneyAccountSnapshot {
  readonly name: string;
  /** Plaid's account type ('depository', 'credit', …) — only depository counts as spendable. */
  readonly accountType: string;
  readonly isoCurrencyCode: string | null;
  readonly availableMicros: bigint | null;
  readonly currentMicros: bigint | null;
}

/** A minimized transaction — merchant, amount, date. Positive amount = money leaving the account. */
export interface MoneyTransactionView {
  readonly merchant: string;
  readonly amountMicros: bigint;
  readonly isoCurrencyCode: string | null;
  /** YYYY-MM-DD. */
  readonly postedAt: string;
  readonly pending: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Spending-pace window and the runway threshold under which the projection becomes a fact. */
const BURN_WINDOW_DAYS = 30;
const LOW_RUNWAY_DAYS = 7;

/** A charge is "unusual" when it lands in this recent window, exceeds the typical charge by the
 * multiple, and clears the floor (so a $9 charge against a $2 median never fires). */
const UNUSUAL_WINDOW_DAYS = 7;
const UNUSUAL_MULTIPLE = 3n;
const UNUSUAL_FLOOR_MICROS = 50_000_000n; // 50 units of the currency

/** A merchant is "recurring" after this many charges spaced roughly a month apart. */
const RECURRING_MIN_CHARGES = 3;
const RECURRING_GAP_MIN_DAYS = 24;
const RECURRING_GAP_MAX_DAYS = 38;
/** How much a recurring charge must rise, in percent, before it becomes a creep fact. */
const CREEP_MIN_INCREASE_PERCENT = 10n;

function parseDay(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function daysBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / MS_PER_DAY;
}

/** Render micros for a fact string: "123.45 USD" (display only — never fed back into arithmetic). */
function formatMoney(micros: bigint, currency: string | null): string {
  const units = Number(micros) / 1_000_000;
  const rendered = units.toFixed(2);
  return currency === null ? rendered : `${rendered} ${currency}`;
}

/** Group a list by the transaction currency, keeping null currencies together under ''. */
function currencyKey(code: string | null): string {
  return code ?? '';
}

/**
 * Low-balance projection: recent spending pace vs. what's spendable now, per currency. Only
 * depository balances count (a credit-card "balance" is debt); only settled outflows set the pace.
 */
function lowBalanceFacts(
  accounts: ReadonlyArray<MoneyAccountSnapshot>,
  transactions: ReadonlyArray<MoneyTransactionView>,
  now: Date,
): string[] {
  const spendableByCurrency = new Map<string, { total: bigint; currency: string | null }>();
  for (const account of accounts) {
    if (account.accountType !== 'depository') {
      continue;
    }
    const balance = account.availableMicros ?? account.currentMicros;
    if (balance === null) {
      continue;
    }
    const key = currencyKey(account.isoCurrencyCode);
    const entry = spendableByCurrency.get(key);
    if (entry) {
      entry.total += balance;
    } else {
      spendableByCurrency.set(key, { total: balance, currency: account.isoCurrencyCode });
    }
  }

  const windowStart = new Date(now.getTime() - BURN_WINDOW_DAYS * MS_PER_DAY);
  const outflowByCurrency = new Map<string, bigint>();
  for (const t of transactions) {
    if (t.pending || t.amountMicros <= 0n) {
      continue;
    }
    const posted = parseDay(t.postedAt);
    if (posted.getTime() < windowStart.getTime() || posted.getTime() > now.getTime()) {
      continue;
    }
    const key = currencyKey(t.isoCurrencyCode);
    outflowByCurrency.set(key, (outflowByCurrency.get(key) ?? 0n) + t.amountMicros);
  }

  const facts: string[] = [];
  for (const [key, { total, currency }] of spendableByCurrency) {
    const outflow = outflowByCurrency.get(key) ?? 0n;
    if (outflow <= 0n || total < 0n) {
      continue;
    }
    const dailyBurn = outflow / BigInt(BURN_WINDOW_DAYS);
    if (dailyBurn <= 0n) {
      continue;
    }
    const runwayDays = total / dailyBurn;
    if (runwayDays < BigInt(LOW_RUNWAY_DAYS)) {
      facts.push(
        `At your recent spending pace (about ${formatMoney(dailyBurn, currency)}/day), ` +
          `your bank balance of about ${formatMoney(total, currency)} covers roughly ` +
          `${runwayDays} more day${runwayDays === 1n ? '' : 's'}`,
      );
    }
  }
  return facts;
}

/** Unusual charge: a recent charge far above the typical (median) charge before the window. */
function unusualChargeFacts(
  transactions: ReadonlyArray<MoneyTransactionView>,
  now: Date,
): string[] {
  const windowStart = new Date(now.getTime() - UNUSUAL_WINDOW_DAYS * MS_PER_DAY);

  const byCurrency = new Map<string, { baseline: bigint[]; recent: MoneyTransactionView[] }>();
  for (const t of transactions) {
    if (t.amountMicros <= 0n) {
      continue;
    }
    const key = currencyKey(t.isoCurrencyCode);
    let entry = byCurrency.get(key);
    if (entry === undefined) {
      entry = { baseline: [], recent: [] };
      byCurrency.set(key, entry);
    }
    const posted = parseDay(t.postedAt);
    if (posted.getTime() >= windowStart.getTime()) {
      entry.recent.push(t);
    } else if (!t.pending) {
      entry.baseline.push(t.amountMicros);
    }
  }

  const facts: string[] = [];
  for (const { baseline, recent } of byCurrency.values()) {
    if (baseline.length === 0) {
      continue; // No history to compare against — no fact is honest here.
    }
    const sorted = [...baseline].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median === undefined) {
      continue;
    }
    const threshold = median * UNUSUAL_MULTIPLE;
    for (const t of recent) {
      if (t.amountMicros > threshold && t.amountMicros > UNUSUAL_FLOOR_MICROS) {
        const at = t.merchant.length > 0 ? ` at ${t.merchant}` : '';
        facts.push(
          `A charge of ${formatMoney(t.amountMicros, t.isoCurrencyCode)}${at} on ${t.postedAt} ` +
            `is much larger than your typical charge (about ${formatMoney(median, t.isoCurrencyCode)})`,
        );
      }
    }
  }
  return facts;
}

/**
 * Subscription creep: merchants charging roughly monthly. Surfaces the recurring set's monthly
 * total, and any recurring charge that has grown since its first occurrence.
 */
function subscriptionFacts(transactions: ReadonlyArray<MoneyTransactionView>): string[] {
  const byMerchant = new Map<string, MoneyTransactionView[]>();
  for (const t of transactions) {
    if (t.pending || t.amountMicros <= 0n || t.merchant.trim().length === 0) {
      continue;
    }
    const key = t.merchant.trim().toLowerCase();
    const list = byMerchant.get(key);
    if (list) {
      list.push(t);
    } else {
      byMerchant.set(key, [t]);
    }
  }

  const facts: string[] = [];
  let recurringCount = 0;
  let recurringTotal = 0n;
  let recurringCurrency: string | null = null;
  let mixedCurrencies = false;

  for (const charges of byMerchant.values()) {
    if (charges.length < RECURRING_MIN_CHARGES) {
      continue;
    }
    const sorted = [...charges].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
    let monthlyGaps = 0;
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (prev === undefined || curr === undefined) {
        continue;
      }
      const gap = daysBetween(parseDay(prev.postedAt), parseDay(curr.postedAt));
      if (gap >= RECURRING_GAP_MIN_DAYS && gap <= RECURRING_GAP_MAX_DAYS) {
        monthlyGaps += 1;
      }
    }
    if (monthlyGaps < RECURRING_MIN_CHARGES - 1) {
      continue;
    }

    const first = sorted[0];
    const latest = sorted[sorted.length - 1];
    if (first === undefined || latest === undefined) {
      continue;
    }
    recurringCount += 1;
    recurringTotal += latest.amountMicros;
    if (recurringCount === 1) {
      recurringCurrency = latest.isoCurrencyCode;
    } else if (recurringCurrency !== latest.isoCurrencyCode) {
      mixedCurrencies = true;
    }

    const grewBy = latest.amountMicros - first.amountMicros;
    if (grewBy * 100n > first.amountMicros * CREEP_MIN_INCREASE_PERCENT) {
      facts.push(
        `Your recurring charge at ${latest.merchant} has risen from ` +
          `${formatMoney(first.amountMicros, first.isoCurrencyCode)} to ` +
          `${formatMoney(latest.amountMicros, latest.isoCurrencyCode)}`,
      );
    }
  }

  if (recurringCount > 0 && !mixedCurrencies) {
    facts.push(
      `You have ${recurringCount} recurring monthly charge${recurringCount === 1 ? '' : 's'} ` +
        `totalling about ${formatMoney(recurringTotal, recurringCurrency)}/month`,
    );
  } else if (recurringCount > 0) {
    // Mixed currencies have no honest single total — count them, don't sum them.
    facts.push(`You have ${recurringCount} recurring monthly charges across multiple currencies`);
  }
  return facts;
}

export function extractMoneyFacts(
  accounts: ReadonlyArray<MoneyAccountSnapshot>,
  transactions: ReadonlyArray<MoneyTransactionView>,
  now: Date,
): string[] {
  return [
    ...lowBalanceFacts(accounts, transactions, now),
    ...unusualChargeFacts(transactions, now),
    ...subscriptionFacts(transactions),
  ];
}
