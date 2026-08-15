import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChargeInvoiceResponse,
  GetInvoiceResponse,
  GetOrgBillingResponse,
  ListInvoicesResponse,
  ListPlansResponse,
  MarkInvoicePaidResponse,
  SetSubscriptionResponse,
  UpsertPlanResponse,
} from '@stewra/shared-types';
import { COMMERCE_BILLING_COLLECTORS } from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { billingService } from '../services/billingService.js';
import { paymentService } from '../services/paymentService.js';
import { dunningService } from '../services/dunningService.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { parse } from '../../utils/validate.js';
import { AuthenticationError } from '../../utils/errors.js';

const upsertPlanSchema = z.object({
  name: z.string().min(1).max(120),
  // Digits-only micros string, same shape and same 15-digit sanity bound as the spend caps.
  platformFeeMicros: z.string().regex(/^\d{1,15}$/, 'platformFeeMicros must be a digits-only string'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an uppercase ISO 4217 code'),
  note: z.string().min(1).max(2000),
});

const setSubscriptionSchema = z
  .object({
    orgId: z.string().uuid(),
    planId: z.string().uuid().nullable(),
    // No `.default()`. Whoever puts an org on a plan states who bills it; guessing here bills a
    // customer twice or never, and both failures are silent for a month.
    collector: z.enum(COMMERCE_BILLING_COLLECTORS).nullable(),
    note: z.string().min(1).max(2000),
  })
  .superRefine((body, ctx) => {
    if (body.planId !== null && body.collector === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collector'],
        message: 'collector is required when subscribing to a plan',
      });
    }
    if (body.planId === null && body.collector !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collector'],
        message: 'collector must be null when ending a subscription — nobody collects nothing',
      });
    }
  });

const invoiceParamsSchema = z.object({
  invoiceId: z.string().uuid(),
});

const markPaidSchema = z.object({
  note: z.string().min(1).max(2000),
});

/**
 * The two faces of billing, unequal the same way the spend caps are.
 *
 * `upsertPlan`/`listPlans`/`setSubscription` are platform-operator surface (`/platform/billing`,
 * behind `requireInstallAdmin`): the catalog and who is on it decide what clients are charged, and
 * a client must never edit either. `orgBilling`/`listInvoices`/`getInvoice` are the org-facing
 * READS — what plan am I on, what have I been billed — and nothing on that surface can write.
 */
class BillingController extends BaseController {
  /** PUT /platform/billing/plans */
  async upsertPlan(req: Request, res: Response): Promise<void> {
    try {
      if (req.userId === undefined) throw new AuthenticationError('Authentication required');
      const body = parse(upsertPlanSchema, req.body);
      const result = await billingService.upsertPlan({ ...body, createdByUserId: req.userId });
      const response: UpsertPlanResponse = result;
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.upsertPlan');
    }
  }

  /** GET /platform/billing/plans */
  async listPlans(_req: Request, res: Response): Promise<void> {
    try {
      const plans = await billingService.listPlans();
      const response: ListPlansResponse = { plans };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.listPlans');
    }
  }

  /** PUT /platform/billing/subscriptions */
  async setSubscription(req: Request, res: Response): Promise<void> {
    try {
      if (req.userId === undefined) throw new AuthenticationError('Authentication required');
      const body = parse(setSubscriptionSchema, req.body);
      const subscription = await billingService.setSubscription({
        ...body,
        createdByUserId: req.userId,
      });
      const response: SetSubscriptionResponse = { subscription };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.setSubscription');
    }
  }

  /** GET /orgs/:orgId/billing */
  async orgBilling(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const subscription = await billingService.activeSubscription(orgId);
      // Returned on the plan endpoint rather than its own, so a client cannot render "you are on
      // the Growth plan" without also having been handed the fact that the last invoice is unpaid.
      const delinquency = await dunningService.delinquency(orgId);
      const response: GetOrgBillingResponse = { subscription, delinquency };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.orgBilling');
    }
  }

  /** GET /orgs/:orgId/invoices */
  async listInvoices(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const invoices = await billingService.listInvoices(orgId);
      const response: ListInvoicesResponse = { invoices };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.listInvoices');
    }
  }

  /** GET /orgs/:orgId/invoices/:invoiceId */
  async getInvoice(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const params = parse(invoiceParamsSchema, req.params);
      const result = await billingService.getInvoice(orgId, params.invoiceId);
      const attempts = await paymentService.attemptsForInvoice(params.invoiceId);
      const response: GetInvoiceResponse = { ...result, attempts };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.getInvoice');
    }
  }

  /** POST /platform/billing/invoices/:invoiceId/mark-paid */
  async markInvoicePaid(req: Request, res: Response): Promise<void> {
    try {
      if (req.userId === undefined) throw new AuthenticationError('Authentication required');
      const params = parse(invoiceParamsSchema, req.params);
      const body = parse(markPaidSchema, req.body);
      const invoice = await paymentService.markInvoicePaid(params.invoiceId, body.note);
      const response: MarkInvoicePaidResponse = { invoice };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.markInvoicePaid');
    }
  }

  /** POST /platform/billing/invoices/:invoiceId/charge */
  async chargeInvoice(req: Request, res: Response): Promise<void> {
    try {
      if (req.userId === undefined) throw new AuthenticationError('Authentication required');
      const params = parse(invoiceParamsSchema, req.params);
      const result = await paymentService.chargeInvoice(params.invoiceId);
      const response: ChargeInvoiceResponse = result;
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.chargeInvoice');
    }
  }
}

export const billingController = new BillingController();
