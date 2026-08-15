import type {
  CommerceInvoice,
  CommercePaymentAttempt,
  CommercePaymentMethodState,
} from '@stewra/shared-types';
import { config } from '../../config/unifiedConfig.js';
import { db } from '../../database/index.js';
import { billingCustomerRepository } from '../repositories/billingCustomerRepository.js';
import { invoiceRepository } from '../repositories/invoiceRepository.js';
import { paymentAttemptRepository } from '../repositories/paymentAttemptRepository.js';
import { buildPaymentProvider } from './payments/index.js';
import type { PaymentEvent, PaymentProvider } from './payments/types.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Collection: the one place invoices meet the payment port. Only ISSUED invoices are collectible —
 * a draft has not finished claiming to be a bill, and `paid`/`void` are already over.
 *
 * The idempotency chain has three links, each catching what the previous cannot: the attempt
 * row's unique key stops two local collectors racing the same charge; the key travels on the wire
 * so a retried request that already charged is deduped by the provider; and the webhook that
 * finishes the story finds its attempt by provider ref, where a replay meets an attempt that is
 * no longer pending and changes nothing.
 */
class PaymentService {
  /**
   * Record an offline settlement — the operator attests the money arrived. Provider-independent
   * on purpose: a client may always pay by wire, whatever this install charges cards with.
   */
  async markInvoicePaid(invoiceId: string, note: string): Promise<CommerceInvoice> {
    const invoice = await invoiceRepository.findById(invoiceId);
    if (invoice === null) throw new NotFoundError('Invoice not found.');
    if (invoice.status === 'paid') return invoice; // Attested twice is still paid once.
    if (invoice.status !== 'issued') {
      throw new ValidationError('Validation failed', [
        {
          field: 'invoiceId',
          message: `Only an issued invoice can be marked paid; this one is ${invoice.status}.`,
        },
      ]);
    }
    // The attestation is an attempt row like any other — succeeded, manual, the note as evidence.
    const attempt = await paymentAttemptRepository.create({
      invoiceId,
      provider: 'manual',
      idempotencyKey: `manual-${invoiceId}-${await paymentAttemptRepository.countForInvoice(invoiceId) + 1}`,
    });
    if (attempt !== null) {
      await paymentAttemptRepository.recordOutcome({
        attemptId: attempt.id,
        status: 'succeeded',
        providerRef: null,
        error: null,
      });
      // The note is evidence, not an error, so it does not land on the attempt's error column; it
      // goes to the operator-action record we have — the application log, with the ids beside it.
      logger.info('commerce payments: invoice marked paid by operator attestation', {
        invoiceId,
        note,
      });
    }
    const paid = await invoiceRepository.markPaid(invoiceId);
    if (paid === null) throw new NotFoundError('Invoice not found.');
    return paid;
  }

  /**
   * What the billing page renders its card section from: which provider collects here, whether a
   * method is already stored, and the browser-side key needed to capture one.
   *
   * Reads the CONFIGURED provider rather than whatever rows happen to exist, so an install that
   * switched from manual to Stripe reports honestly that no Stripe method is on file yet instead
   * of pointing at a stale manual customer.
   */
  async paymentMethodState(orgId: string): Promise<CommercePaymentMethodState> {
    const provider = buildPaymentProvider();
    const existing = await billingCustomerRepository.find(orgId, provider.provider);
    const cfg = config.commerceBilling;
    return {
      provider: provider.provider,
      stored: existing?.paymentMethodRef != null,
      publishableKey: cfg.provider === 'stripe' ? cfg.publishableKey : null,
    };
  }

  /**
   * Begin card capture for an org: ensure the provider-side customer exists, then start the
   * provider's own setup flow and hand the browser what its SDK needs.
   *
   * The card itself never touches this server. What comes back is a client secret the provider's
   * script exchanges directly with the provider, which is the entire point of doing it this way —
   * nothing here is ever in scope for a card number.
   */
  async startPaymentMethodSetup(orgId: string): Promise<{ clientSecret: string; setupRef: string }> {
    const provider = this.collectingProvider();
    const org = await db
      .selectFrom('organizations')
      .select(['id', 'name'])
      .where('id', '=', orgId)
      .executeTakeFirst();
    if (org === undefined) throw new NotFoundError(`Organization ${orgId} does not exist.`);

    const existing = await billingCustomerRepository.find(orgId, provider.provider);
    const customerRef = await provider.ensureCustomer({
      orgId: org.id,
      name: org.name,
      existingCustomerRef: existing?.customerRef ?? null,
    });
    if (existing === null || existing.customerRef !== customerRef) {
      await billingCustomerRepository.saveCustomerRef({
        orgId,
        provider: provider.provider,
        customerRef,
      });
    }

    const started = await provider.startPaymentMethodSetup({ customerRef });
    if (started.clientSecret === null || started.setupRef === null) {
      // The collecting-provider guard above already excluded the only provider that answers null.
      throw new ValidationError('Validation failed', [
        { field: 'provider', message: 'This provider has no payment-method setup flow.' },
      ]);
    }
    return { clientSecret: started.clientSecret, setupRef: started.setupRef };
  }

  /**
   * Finish card capture: ask the provider what that setup actually attached, and store it.
   *
   * The caller sends only the setup's id. Everything that decides which card gets charged is read
   * back from the provider — see `finishPaymentMethodSetup` in the port for why believing the
   * browser here would let one org's admin point Stewra at another org's card.
   */
  async confirmPaymentMethod(orgId: string, setupRef: string): Promise<void> {
    const provider = this.collectingProvider();
    const existing = await billingCustomerRepository.find(orgId, provider.provider);
    if (existing === null) {
      throw new ValidationError('Validation failed', [
        {
          field: 'setupRef',
          message: 'This organization has no billing customer yet; start the setup first.',
        },
      ]);
    }
    const { paymentMethodRef } = await provider.finishPaymentMethodSetup({
      setupRef,
      customerRef: existing.customerRef,
    });
    await billingCustomerRepository.savePaymentMethodRef({
      orgId,
      provider: provider.provider,
      paymentMethodRef,
    });
    logger.info('commerce payments: payment method stored for org', {
      orgId,
      provider: provider.provider,
    });
  }

  /**
   * The configured provider, refusing if it is the one that does not move money. Shared by both
   * halves of card capture and by `chargeInvoice`, so a manual install gives the same answer
   * everywhere instead of failing differently depending on which door you came through.
   */
  private collectingProvider(): PaymentProvider {
    const provider = buildPaymentProvider();
    if (provider.provider === 'manual') {
      throw new ValidationError('Validation failed', [
        {
          field: 'provider',
          message:
            'This install collects manually; there is no card to store and nothing to charge.',
        },
      ]);
    }
    return provider;
  }

  /** Collect one issued invoice through the configured provider. */
  async chargeInvoice(invoiceId: string): Promise<{
    attempt: CommercePaymentAttempt;
    invoice: CommerceInvoice;
  }> {
    const provider = buildPaymentProvider();
    if (provider.provider === 'manual') {
      throw new ValidationError('Validation failed', [
        {
          field: 'provider',
          message:
            'This install collects manually; record the settlement with mark-paid instead of charging.',
        },
      ]);
    }
    const invoice = await invoiceRepository.findById(invoiceId);
    if (invoice === null) throw new NotFoundError('Invoice not found.');
    if (invoice.status !== 'issued') {
      throw new ValidationError('Validation failed', [
        {
          field: 'invoiceId',
          message: `Only an issued invoice can be charged; this one is ${invoice.status}.`,
        },
      ]);
    }

    const org = await db
      .selectFrom('organizations')
      .select(['id', 'name'])
      .where('id', '=', invoice.orgId)
      .executeTakeFirstOrThrow();
    const existing = await billingCustomerRepository.find(invoice.orgId, provider.provider);
    const customerRef = await provider.ensureCustomer({
      orgId: org.id,
      name: org.name,
      existingCustomerRef: existing?.customerRef ?? null,
    });
    if (existing === null || existing.customerRef !== customerRef) {
      await billingCustomerRepository.saveCustomerRef({
        orgId: invoice.orgId,
        provider: provider.provider,
        customerRef,
      });
    }

    // Claiming the numbered key IS the right to make this charge; a racing collector loses here.
    const attemptNumber = (await paymentAttemptRepository.countForInvoice(invoiceId)) + 1;
    const attempt = await paymentAttemptRepository.create({
      invoiceId,
      provider: provider.provider,
      idempotencyKey: `invoice-${invoiceId}-${attemptNumber}`,
    });
    if (attempt === null) {
      throw new ValidationError('Validation failed', [
        { field: 'invoiceId', message: 'A collection attempt for this invoice is already in flight.' },
      ]);
    }

    const outcome = await provider.chargeInvoice({
      invoiceId,
      orgId: invoice.orgId,
      amountMicros: BigInt(invoice.totalMicros),
      currency: invoice.currency,
      customerRef,
      paymentMethodRef: existing?.paymentMethodRef ?? null,
      idempotencyKey: `invoice-${invoiceId}-${attemptNumber}`,
    });

    if (outcome.status === 'succeeded') {
      const settled = await paymentAttemptRepository.recordOutcome({
        attemptId: attempt.id,
        status: 'succeeded',
        providerRef: outcome.providerRef,
        error: null,
      });
      const paid = await invoiceRepository.markPaid(invoiceId);
      if (paid === null) throw new NotFoundError('Invoice not found.');
      return { attempt: settled, invoice: paid };
    }
    if (outcome.status === 'failed') {
      const failed = await paymentAttemptRepository.recordOutcome({
        attemptId: attempt.id,
        status: 'failed',
        providerRef: null,
        error: outcome.error,
      });
      return { attempt: failed, invoice };
    }
    // Pending: the provider took the order; its webhook will finish the story. The provider ref is
    // stored NOW because it is the only handle the webhook has to find this attempt again.
    const pending =
      outcome.providerRef === null
        ? attempt
        : await paymentAttemptRepository.saveProviderRef(attempt.id, outcome.providerRef);
    return { attempt: pending, invoice };
  }

  /** Apply one verified, normalized provider event. Replays find nothing pending and change nothing. */
  async applyEvent(event: PaymentEvent): Promise<void> {
    if (event.kind === 'ignored') return;
    const attempt = await paymentAttemptRepository.findPendingByProviderRef(event.providerRef);
    if (attempt === null) {
      logger.info('commerce payments: webhook event matched no pending attempt — replay or foreign', {
        kind: event.kind,
        providerRef: event.providerRef,
      });
      return;
    }
    if (event.kind === 'charge_succeeded') {
      await paymentAttemptRepository.recordOutcome({
        attemptId: attempt.id,
        status: 'succeeded',
        providerRef: event.providerRef,
        error: null,
      });
      await invoiceRepository.markPaid(attempt.invoiceId);
      logger.info('commerce payments: invoice paid by provider webhook', {
        invoiceId: attempt.invoiceId,
        providerRef: event.providerRef,
      });
      return;
    }
    await paymentAttemptRepository.recordOutcome({
      attemptId: attempt.id,
      status: 'failed',
      providerRef: event.providerRef,
      error: event.error,
    });
    logger.info('commerce payments: charge failed at the provider', {
      invoiceId: attempt.invoiceId,
      providerRef: event.providerRef,
      error: event.error,
    });
  }

  async attemptsForInvoice(invoiceId: string): Promise<CommercePaymentAttempt[]> {
    return paymentAttemptRepository.listForInvoice(invoiceId);
  }
}

export const paymentService = new PaymentService();
