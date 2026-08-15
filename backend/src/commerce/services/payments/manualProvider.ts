import { ValidationError } from '../../../utils/errors.js';
import type { ChargeOutcome, PaymentEvent, PaymentProvider } from './types.js';

/**
 * The default provider: offline settlement. It RECORDS money, it never MOVES it — a bank transfer,
 * a check, a payment made entirely outside the system, attested afterwards by an operator through
 * `mark-paid`.
 *
 * Every method answers honestly for that world: the "customer" is just a stable local reference,
 * there is no payment method to set up, a charge is an open ask that only an operator's
 * attestation ever closes, and there is no webhook — anything POSTing to the payments webhook
 * under this provider is by definition not a payment provider.
 */
class ManualProvider implements PaymentProvider {
  readonly provider = 'manual' as const;

  ensureCustomer(params: { orgId: string; existingCustomerRef: string | null }): Promise<string> {
    return Promise.resolve(params.existingCustomerRef ?? `manual:${params.orgId}`);
  }

  startPaymentMethodSetup(): Promise<{ clientSecret: null; setupRef: null }> {
    return Promise.resolve({ clientSecret: null, setupRef: null });
  }

  finishPaymentMethodSetup(): Promise<{ paymentMethodRef: string }> {
    // Unreachable through the service, which refuses the whole flow on a manual install — and a
    // throw rather than a null so that if it ever DOES become reachable, it says so instead of
    // quietly storing a payment method that does not exist.
    return Promise.reject(
      new ValidationError('Validation failed', [
        {
          field: 'provider',
          message: 'This install settles offline; there is no card setup to finish.',
        },
      ]),
    );
  }

  chargeInvoice(): Promise<ChargeOutcome> {
    // Not failed and not succeeded: the ask now exists, and an operator's mark-paid resolves it.
    // The idempotency key is honored trivially — nothing is sent anywhere to duplicate.
    return Promise.resolve({ status: 'pending', providerRef: null });
  }

  verifyWebhook(): PaymentEvent {
    throw new ValidationError('Validation failed', [
      {
        field: 'provider',
        message: 'The manual payment provider has no webhook; this delivery cannot be genuine.',
      },
    ]);
  }
}

export const manualProvider = new ManualProvider();
