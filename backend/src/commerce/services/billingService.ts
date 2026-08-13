import type {
  CommerceInvoice,
  CommerceInvoiceLine,
  CommercePlan,
  CommercePlanVersion,
  CommerceSubscriptionView,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import { commerceInboxRepository } from '../repositories/commerceInboxRepository.js';
import { invoiceRepository } from '../repositories/invoiceRepository.js';
import type { InvoiceLineInput } from '../repositories/invoiceRepository.js';
import { messageCostRepository } from '../repositories/messageCostRepository.js';
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
 * Turn one org's ended calendar month into invoices — or refuse, honestly, while anything in it is
 * still unrated or unpriced.
 *
 * The pricing model on the resulting document is exactly two line kinds: Meta's message charges
 * passed through at the price the rater snapshotted (one line per currency, one invoice per
 * currency — never a conversion), and the flat platform fee from the org's plan version. A period
 * with discrepancies still gets its invoices, held at `draft` with the counts on their face, so
 * the operator sees the money AND the reason it is not final yet.
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
   * Close (or re-attempt) one org's month. Idempotent from every direction: an issued invoice is
   * never touched, a draft is rebuilt whole, the period marker records the outcome, and re-running
   * a closed period returns without writing.
   */
  async closePeriod(params: { orgId: string; periodStart: string }): Promise<{
    outcome: 'closed' | 'still_open' | 'already_closed';
    invoices: CommerceInvoice[];
  }> {
    if (!PERIOD_START_PATTERN.test(params.periodStart)) {
      throw new ValidationError('Validation failed', [
        { field: 'periodStart', message: 'periodStart must be the first of a month, YYYY-MM-01.' },
      ]);
    }
    if (params.periodStart >= currentPeriodStart(new Date())) {
      // A month still receiving receipts has no total yet — closing it would freeze a lie.
      throw new ValidationError('Validation failed', [
        { field: 'periodStart', message: 'Only an ended month can be closed.' },
      ]);
    }
    if (await invoiceRepository.isPeriodClosed(params.orgId, params.periodStart)) {
      return { outcome: 'already_closed', invoices: [] };
    }

    const periodEnd = periodEndFor(params.periodStart);
    const from = new Date(`${params.periodStart}T00:00:00.000Z`);
    const to = new Date(`${periodEnd}T00:00:00.000Z`);

    const [counts, money, subscription] = await Promise.all([
      commerceInboxRepository.costSummary({ orgId: params.orgId, from, to }),
      messageCostRepository.moneySummary({ orgId: params.orgId, from, to }),
      planRepository.subscriptionForPeriod(params.orgId, from, to),
    ]);
    // The same two gaps `GET /costs` folds into `complete`: messages the rater refused to price,
    // and messages no receipt has priced. Either one holds every invoice of the period at draft —
    // an unpriced message could belong to ANY currency, so no single document can claim finality.
    const unratedBillable = Object.values(money.unratedBillable).reduce((a, b) => a + b, 0);
    const complete = !messageCostRepository.hasUnrated(money) && counts.unpricedMessages === 0;

    // One invoice per currency that has money in the period; the platform fee lands on the invoice
    // of ITS OWN currency, created outright if message spend never touched that currency.
    const linesByCurrency = new Map<string, InvoiceLineInput[]>();
    for (const [currency, totals] of Object.entries(money.byCurrency)) {
      if (BigInt(totals.ratedMicros) === 0n && totals.conversationDupMessages === 0) continue;
      const dupNote =
        totals.conversationDupMessages > 0
          ? ` ${totals.conversationDupMessages} further conversation-priced messages carried no additional charge.`
          : '';
      linesByCurrency.set(currency, [
        {
          kind: 'message_costs',
          description: `WhatsApp message charges ${params.periodStart} to ${periodEnd}, passed through at Meta's published rates: ${totals.ratedMessages} rated messages.${dupNote}`,
          quantity: totals.ratedMessages,
          amountMicros: BigInt(totals.ratedMicros),
        },
      ]);
    }
    if (subscription !== null) {
      const lines = linesByCurrency.get(subscription.currency) ?? [];
      lines.push({
        kind: 'platform_fee',
        description: `Platform fee ${params.periodStart} to ${periodEnd} — plan "${subscription.planName}" v${subscription.planVersion}. The flat fee is not prorated.`,
        quantity: 1,
        amountMicros: BigInt(subscription.platformFeeMicros),
      });
      linesByCurrency.set(subscription.currency, lines);
    }

    const invoices: CommerceInvoice[] = [];
    for (const [currency, lines] of [...linesByCurrency.entries()].sort()) {
      invoices.push(
        await invoiceRepository.writeCloseOutcome({
          orgId: params.orgId,
          currency,
          periodStart: params.periodStart,
          periodEnd,
          lines,
          unratedBillable,
          unpricedMessages: counts.unpricedMessages,
          issue: complete,
        }),
      );
    }

    await invoiceRepository.markPeriod({
      orgId: params.orgId,
      periodStart: params.periodStart,
      status: complete ? 'closed' : 'open',
      unratedBillable,
      unpricedMessages: counts.unpricedMessages,
    });
    logger.info('commerce billing: period close attempt finished', {
      orgId: params.orgId,
      periodStart: params.periodStart,
      complete,
      invoices: invoices.length,
      unratedBillable,
      unpricedMessages: counts.unpricedMessages,
    });
    return { outcome: complete ? 'closed' : 'still_open', invoices };
  }
}

export const billingService = new BillingService();
