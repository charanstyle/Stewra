import type { CommercePaymentProvider } from '@stewra/shared-types';

/**
 * The payment port. Everything billing knows about moving money fits in these four calls; nothing
 * outside this directory may know which provider is behind them.
 *
 * Two things live in the PORT rather than an adapter, on purpose:
 *
 *  - **`idempotencyKey` is a required input to every charge.** A provider that cannot honor an
 *    idempotency key is not an acceptable provider, and the type says so — an adapter cannot be
 *    written without deciding what to do with it.
 *  - **`verifyWebhook` returns a normalized {@link PaymentEvent}.** The webhook controller never
 *    touches a provider's own event shape; an adapter that cannot normalize its events into this
 *    union has not finished being written.
 */
export interface PaymentProvider {
  readonly provider: CommercePaymentProvider;

  /**
   * The provider-side customer for an org, created on first need and stable after. Returns the
   * provider's customer reference (opaque; stored in `commerce_billing_customers`).
   */
  ensureCustomer(params: {
    orgId: string;
    name: string;
    existingCustomerRef: string | null;
  }): Promise<string>;

  /**
   * Begin the provider's own payment-method capture flow for a customer. The `clientSecret` is
   * what a front end hands to the provider's SDK; `null` means the provider has no such flow
   * (manual — there is nothing to set up). `setupRef` is this setup's provider-side id, which is
   * the ONLY thing the browser is trusted to hand back — see below.
   */
  startPaymentMethodSetup(params: {
    customerRef: string;
  }): Promise<{ clientSecret: string | null; setupRef: string | null }>;

  /**
   * Read back a finished setup and return the payment method it actually captured.
   *
   * This exists because the browser must never be believed about which card to charge. The
   * obvious shape — the page confirms the setup, then POSTs the payment-method id it got back —
   * lets any authenticated caller name any identifier they like, and the one that eventually gets
   * charged is somebody else's. So the client hands back only the setup's own id, and the server
   * asks the provider three questions: did this setup succeed, does it belong to THIS customer,
   * and what method did it attach. Anything less than all three answers throws.
   *
   * The same rule the store adapters follow for a purchase receipt, for the same reason: what the
   * client sends is a hint about where to look, never the fact itself.
   */
  finishPaymentMethodSetup(params: {
    setupRef: string;
    customerRef: string;
  }): Promise<{ paymentMethodRef: string }>;

  /**
   * Collect one issued invoice. `amountMicros` is bigint micros of `currency`; the adapter owns
   * the conversion to the provider's unit and must REFUSE (throw) any amount its unit cannot
   * represent exactly — a rounded invoice is a wrong invoice.
   */
  chargeInvoice(params: {
    invoiceId: string;
    orgId: string;
    amountMicros: bigint;
    currency: string;
    customerRef: string;
    paymentMethodRef: string | null;
    /** Sent to the provider on the wire; a retried request that already charged must not charge again. */
    idempotencyKey: string;
  }): Promise<ChargeOutcome>;

  /**
   * Authenticate a webhook delivery against the RAW request bytes and normalize it. Throws
   * AuthenticationError on a bad signature; never partially trusts.
   */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | null): PaymentEvent;
}

/** What one charge call established. `pending` means the provider took the order and will webhook. */
export type ChargeOutcome =
  | { readonly status: 'succeeded'; readonly providerRef: string }
  | { readonly status: 'pending'; readonly providerRef: string | null }
  | { readonly status: 'failed'; readonly error: string };

/**
 * A provider's webhook, translated. `ignored` is a first-class member because providers send far
 * more event kinds than billing consumes, and each must be ACKed without being acted on.
 */
export type PaymentEvent =
  | { readonly kind: 'charge_succeeded'; readonly providerRef: string }
  | { readonly kind: 'charge_failed'; readonly providerRef: string; readonly error: string }
  | { readonly kind: 'ignored'; readonly reason: string };
