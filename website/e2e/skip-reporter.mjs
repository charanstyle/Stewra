// A skip census, printed at the end of every run.
//
// TESTING.md states the principle — "a suite that skips silently reads exactly like a suite that
// passed" — and this suite was not holding itself to it. The last full run before this reporter
// existed was 82 passed / 14 skipped / 4 failed, and the fourteen were invisible: `list` prints a
// dash per skipped test as it goes, thousands of lines up, with no reason and no total. Eight of
// them were Today tests skipping on a run that had a database configured and could have provisioned
// what they needed.
//
// So: every skip is named with its reason, they are grouped by reason so a systemic precondition
// (one runner not paired → several tests out) reads as one line rather than five, and E2E_MAX_SKIPS
// turns a budget into an assertion.
import { env, required } from './env.mjs';

/** @implements {import('@playwright/test/reporter').Reporter} */
export default class SkipReporter {
  constructor() {
    /** @type {Array<{ title: string, reason: string }>} */
    this.skipped = [];
    this.total = 0;
  }

  onTestEnd(test, result) {
    this.total += 1;
    if (result.status !== 'skipped') {
      return;
    }
    // Playwright puts the `test.skip(cond, 'why')` description in the annotations; a `fixme`/bare
    // `skip()` has none, which is itself worth showing as such rather than papering over.
    const annotation = test.annotations.find((a) => a.type === 'skip' || a.type === 'fixme');
    this.skipped.push({
      title: test.titlePath().filter(Boolean).join(' › '),
      reason: annotation?.description ?? '(no reason given)',
    });
  }

  // Returning `{ status: 'failed' }` is the only thing that actually reds the run: Playwright sets
  // the process exit code from the aggregated result AFTER reporters finish, so assigning
  // `process.exitCode` here is silently discarded — verified, not assumed.
  onEnd() {
    // NOTE: zero skips reports and then falls THROUGH to the budget check rather than returning here.
    // An early return would exempt the single most important case from the ratchet below — everything
    // provisioned, budget still stale — which is precisely the state that leaves the most room for a
    // regression to skip in unnoticed. (It did exempt it, briefly, until a run with a deliberately
    // wrong budget went green and said so.)
    if (this.skipped.length === 0) {
      console.log(`\n[skips] none — all ${this.total} tests ran.`);
    } else {
      /** @type {Map<string, string[]>} */
      const byReason = new Map();
      for (const s of this.skipped) {
        const titles = byReason.get(s.reason) ?? [];
        titles.push(s.title);
        byReason.set(s.reason, titles);
      }

      console.log(`\n[skips] ${this.skipped.length}/${this.total} tests did not run:`);
      for (const [reason, titles] of byReason) {
        console.log(`  • ${reason}  (${titles.length})`);
        for (const t of titles) {
          console.log(`      ${t}`);
        }
      }
    }

    // Optional budget. Unset means "report, don't enforce" — the census alone is the point, and a
    // default ceiling nobody chose would just get raised the first time it bit. Read via the shared
    // loader so the repo-root .env.e2e can pin it (real env still wins, so CI's value overrides).
    const budget = env['E2E_MAX_SKIPS'];
    if (budget === undefined) {
      return undefined;
    }
    const max = Number.parseInt(required(budget, 'E2E_MAX_SKIPS'), 10);
    if (!Number.isInteger(max) || max < 0) {
      throw new Error(`E2E_MAX_SKIPS must be a non-negative integer, got "${budget}"`);
    }
    if (this.skipped.length > max) {
      console.error(
        `\n[skips] FAILED: ${this.skipped.length} skipped, E2E_MAX_SKIPS=${max}. ` +
          `Provision the missing preconditions above rather than raising the budget.`,
      );
      return { status: 'failed' };
    }
    // EXACT, not a ceiling — a RATCHET. This is the half that was missing, and it is the half that
    // matters over time: a ceiling only ever catches the run that breaches it, so every skip you
    // successfully provision away silently becomes slack, and the next regression to reintroduce a
    // skip lands inside that slack and passes. This suite has already been there — the budget sat at
    // 6 while the true figure was 4, two free regressions wide, and nothing in the run said so.
    //
    // So being UNDER budget fails too, and the fix is a one-line edit the message spells out. It costs
    // exactly one red run at the moment the good news arrives, and in exchange the number can never
    // drift above reality again.
    if (this.skipped.length < max) {
      console.error(
        `\n[skips] FAILED: only ${this.skipped.length} skipped but E2E_MAX_SKIPS=${max}, so the budget ` +
          `is ${max - this.skipped.length} wider than reality — room a future regression could skip in ` +
          `unnoticed. Lower E2E_MAX_SKIPS to ${this.skipped.length}.`,
      );
      return { status: 'failed' };
    }
    return undefined;
  }
}
