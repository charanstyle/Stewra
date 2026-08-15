import type {
  CommerceBillingCollector,
  CommerceInvoice,
  CommerceInvoiceLine,
  CommercePlan,
  CommercePlanVersion,
  CommerceSubscriptionView,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import { invoiceRepository } from '../repositories/invoiceRepository.js';
import type { InvoiceLineInput } from '../repositories/invoiceRepository.js';
import { planRepository } from '../repositories/planRepository.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/** YYYY-MM-01, the only period key this service accepts. */
const PERIOD_START_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-01$/;

/** First day of the month after `periodStart`, as YYYY-MM-DD. */
function periodEndFor(periodStart: string): string {
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  const next = new Date(Date.UTC(year, month, 1)); // Date.UTC months are 0-based: `month` IS next.
  return next.toISOString().slice(0, 10);
}

/** First day of the CURRENT UTC month — the earliest period_start that is not closeable yet. */
function currentPeriodStart(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Turn one org's calendar month into its invoice — IN ADVANCE, on the first day of the month it
 * covers.
 *
 * This service used to do something rather different, and the two reasons it changed are worth
 * keeping written down, because the old shape is the one a reader will expect:
 *
 * **1. There are no message-cost lines any more.** Clients attach their own payment method to
 * their own WABA during Embedded Signup, so Meta bills them directly for every message they send.
 * Stewra never fronts that cost and therefore must never invoice it — a `message_costs` line
 * beside Meta's own charge is the same money billed twice. It is deleted rather than made
 * configurable: there is one intended path and a flag would only preserve the ability to get this
 * wrong.
 *
 * **2. Which means nothing is left to wait for.** The whole draft-until-complete apparatus existed
 * because message money is only known once the delivery receipts land, days later. A flat fee is
 * known on the first day of the period it covers, so the invoice issues immediately and
 * `commerce_billing_periods.status = 'open'` is now a state nothing can produce. The columns
 * recording why a period was open stay (they cost nothing and the history is real) and are written
 * as the honest zeros they now are.
 *
 * **What is NOT invoiced here:** a subscription whose `collector` is `apple` or `google`. The
 * store sold it, the store charges the card, and the store's receipt is the bill. Stewra issuing
 * its own document for that fee would bill the customer a second time for the same month. Those
 * orgs close their period producing no invoice at all, which is the correct number of invoices.
 */
class BillingService {
  /** Create or version a plan. Fee validation mirrors the spend caps: digits-only micros string. */
  async upsertPlan(params: {
    name: string;
    platformFeeMicros: string;
    currency: string;
    note: string;
    createdByUserId: string | null;
  }): Promise<{ plan: CommercePlan; version: CommercePlanVersion }> {
    if (!/^\d{1,15}$/.test(params.platformFeeMicros)) {
      throw new ValidationError('Validation failed', [
        { field: 'platformFeeMicros', message: 'platformFeeMicros must be a digits-only string' },
      ]);
    }
    return planRepository.upsertPlanVersion({
      name: params.name,
      platformFeeMicros: BigInt(params.platformFeeMicros),
      currency: params.currency,
      note: params.note,
      createdByUserId: params.createdByUserId,
    });
  }

  async listPlans(): Promise<{ plan: CommercePlan; versions: CommercePlanVersion[] }[]> {
    return planRepository.listPlans();
  }

  /** Put an org on a plan (or off every plan). Existence-checked so a typoed org is a 404, not an FK 500. */
  async setSubscription(params: {
    orgId: string;
    planId: string | null;
    /** Non-null whenever `planId` is; the repository refuses the mismatch rather than assuming one. */
    collector: CommerceBillingCollector | null;
    note: string;
    createdByUserId: string | null;
  }): Promise<CommerceSubscriptionView | null> {
    const org = await db
      .selectFrom('organizations')
      .select('id')
      .where('id', '=', params.orgId)
      .executeTakeFirst();
    if (org === undefined) throw new NotFoundError(`Organization ${params.orgId} does not exist.`);
    return planRepository.setSubscription(params);
  }

  async activeSubscription(orgId: string): Promise<CommerceSubscriptionView | null> {
    return planRepository.activeSubscription(orgId);
  }

  async listInvoices(orgId: string): Promise<CommerceInvoice[]> {
    return invoiceRepository.listForOrg(orgId);
  }

  async getInvoice(
    orgId: string,
    invoiceId: string,
  ): Promise<{ invoice: CommerceInvoice; lines: CommerceInvoiceLine[] }> {
    const found = await invoiceRepository.getWithLines(orgId, invoiceId);
    if (found === null) throw new NotFoundError('Invoice not found.');
    return found;
  }

  /**
   * Bill one org's month. Idempotent from every direction: an issued invoice is never touched, a
   * draft is rebuilt whole, the period marker records the outcome, and re-running a billed period
   * returns without writing.
   *
   * **The first partial month is free, not prorated.** A subscription that began after the period
   * had already started is not billed for that period — an org signing up on the 28th owes nothing
   * for those three days and is billed in full on the 1st. This keeps the flat fee genuinely flat:
   * every invoice this system has ever produced is one whole month at the plan's exact price, and
   * there is no per-day arithmetic anywhere to disagree with the number on the plan. Charging a
   * full $149 for three days would be the alternative, and it is worse in every direction.
   */
  async closePeriod(params: { orgId: string; periodStart: string }): Promise<{
    outcome: 'closed' | 'already_closed';
    invoices: CommerceInvoice[];
  }> {
    if (!PERIOD_START_PATTERN.test(params.periodStart)) {
      throw new ValidationError('Validation failed', [
        { field: 'periodStart', message: 'periodStart must be the first of a month, YYYY-MM-01.' },
      ]);
    }
    if (params.periodStart > currentPeriodStart(new Date())) {
      // Billing in advance means the CURRENT month is fair game; a month that has not begun is not.
      throw new ValidationError('Validation failed', [
        { field: 'periodStart', message: 'A month that has not started yet cannot be billed.' },
      ]);
    }
    if (await invoiceRepository.isPeriodClosed(params.orgId, params.periodStart)) {
      return { outcome: 'already_closed', invoices: [] };
    }

    const periodEnd = periodEndFor(params.periodStart);
    const from = new Date(`${params.periodStart}T00:00:00.000Z`);
    const to = new Date(`${periodEnd}T00:00:00.000Z`);

    const subscription = await planRepository.subscriptionForPeriod(params.orgId, from, to);
    const invoices: CommerceInvoice[] = [];

    // Three separate reasons there may be no invoice, none of them an error: no subscription at
    // all, a subscription that started mid-period (free until the next 1st), or a subscription the
    // App Store or Play is already collecting.
    const billable =
      subscription !== null &&
      subscription.collector === 'stewra_stripe' &&
      new Date(subscription.startedAt) <= from;

    if (billable && subscription !== null) {
      const lines: InvoiceLineInput[] = [
        {
          kind: 'platform_fee',
          description: `Platform fee ${params.periodStart} to ${periodEnd} — plan "${subscription.planName}" v${subscription.planVersion}. Charged in advance for the month ahead; the flat fee is not prorated.`,
          quantity: 1,
          amountMicros: BigInt(subscription.platformFeeMicros),
        },
      ];
      invoices.push(
        await invoiceRepository.writeCloseOutcome({
          orgId: params.orgId,
          currency: subscription.currency,
          periodStart: params.periodStart,
          periodEnd,
          lines,
          // Message money no longer reaches an invoice, so there is no discrepancy that could hold
          // one at draft. These are the true counts of what is unresolved on this document: none.
          unratedBillable: 0,
          unpricedMessages: 0,
          issue: true,
        }),
      );
    }

    await invoiceRepository.markPeriod({
      orgId: params.orgId,
      periodStart: params.periodStart,
      status: 'closed',
      unratedBillable: 0,
      unpricedMessages: 0,
    });
    logger.info('commerce billing: period billed', {
      orgId: params.orgId,
      periodStart: params.periodStart,
      collector: subscription?.collector ?? null,
      invoices: invoices.length,
    });
    return { outcome: 'closed', invoices };
  }
}

export const billingService = new BillingService();
