import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChargeInvoiceResponse,
  ClaimStorePurchaseResponse,
  GetInvoiceResponse,
  GetOrgBillingResponse,
  ListInvoicesResponse,
  ListPlansResponse,
  MarkInvoicePaidResponse,
  StartPaymentMethodSetupResponse,
  ConfirmPaymentMethodResponse,
  SetSubscriptionResponse,
  UpsertPlanResponse,
} from '@stewra/shared-types';
import { COMMERCE_BILLING_COLLECTORS, COMMERCE_STORES } from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { billingService } from '../services/billingService.js';
import { paymentService } from '../services/paymentService.js';
import { dunningService } from '../services/dunningService.js';
import { storeSubscriptionService } from '../services/storeSubscriptionService.js';
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

// The setup's own id and nothing else. A payment-method id here would let any org admin name a
// card that is not theirs; the server reads the method back from the provider instead.
const confirmPaymentMethodSchema = z.object({
  setupRef: z.string().min(1).max(255),
});

const markPaidSchema = z.object({
  note: z.string().min(1).max(2000),
});

/**
 * A reference, and which store issued it. Nothing else is accepted and nothing else would be used:
 * the server reads the product, the status and the period end back from the store's own API, so
 * every additional field here would be a field a decompiled app could assert.
 *
 * 255 matches the column. Both stores' identifiers are far shorter — an `originalTransactionId` is
 * numeric and a Play purchase token is a long opaque string — so this is a sanity bound, not a
 * format claim: guessing at either store's format is how a legitimate purchase gets refused after
 * the customer has already been charged.
 */
const claimStorePurchaseSchema = z.object({
  store: z.enum(COMMERCE_STORES),
  storeSubscriptionRef: z.string().min(1).max(255),
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
      const paymentMethod = await paymentService.paymentMethodState(orgId);
      // Same argument as the delinquency above: a client must not be able to render "add a card"
      // without also having been handed the fact that a store is already charging this customer.
      const storeSubscriptions = await storeSubscriptionService.listForOrg(orgId);
      const response: GetOrgBillingResponse = {
        subscription,
        delinquency,
        paymentMethod,
        storeSubscriptions,
      };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.orgBilling');
    }
  }

  /**
   * POST /orgs/:orgId/billing/store-purchase
   *
   * The app's side of an in-app purchase. It reports a reference; the server asks the store what
   * that reference actually is and writes only what the store said. See `claimPurchase` for the
   * four refusals — wrong ledger, wrong product, not paid up, already somebody else's.
   */
  async claimStorePurchase(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const body = parse(claimStorePurchaseSchema, req.body);
      const storeSubscription = await storeSubscriptionService.claimPurchase({
        orgId,
        store: body.store,
        storeSubscriptionRef: body.storeSubscriptionRef,
      });
      // Read back rather than assembled: the claim may have created the plan tenure, and the app
      // renders entitlement from this in the same round trip.
      const subscription = await billingService.activeSubscription(orgId);
      const response: ClaimStorePurchaseResponse = { storeSubscription, subscription };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.claimStorePurchase');
    }
  }

  /** POST /orgs/:orgId/billing/payment-method/setup */
  async startPaymentMethodSetup(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const started = await paymentService.startPaymentMethodSetup(orgId);
      const response: StartPaymentMethodSetupResponse = started;
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.startPaymentMethodSetup');
    }
  }

  /** POST /orgs/:orgId/billing/payment-method */
  async confirmPaymentMethod(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const body = parse(confirmPaymentMethodSchema, req.body);
      await paymentService.confirmPaymentMethod(orgId, body.setupRef);
      const response: ConfirmPaymentMethodResponse = {
        paymentMethod: await paymentService.paymentMethodState(orgId),
      };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'BillingController.confirmPaymentMethod');
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
