import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../../config/unifiedConfig.js';
import {
  AuthenticationError,
  ServiceUnavailableError,
  ValidationError,
} from '../../../utils/errors.js';
import type { ChargeOutcome, PaymentEvent, PaymentProvider } from './types.js';

/**
 * Stripe over plain `fetch`, the same way `metaGraph.ts` talks to Meta: form-encoded requests,
 * responses parsed with zod rather than asserted, provider error text surfaced verbatim, and a
 * disabled/misconfigured integration that refuses instead of degrading. No SDK — the four calls
 * billing needs do not justify a dependency that can move under us.
 */

/**
 * ISO 4217 currencies Stripe treats as zero-decimal (the amount IS the whole unit). Everything
 * else is two-decimal on Stripe's wire. Copied from Stripe's own documentation list; a currency
 * whose micros do not divide exactly into its wire unit is REFUSED, never rounded.
 */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Micros → Stripe's wire unit for the currency, exact or refused. */
export function stripeAmount(amountMicros: bigint, currency: string): bigint {
  const perUnit = ZERO_DECIMAL.has(currency) ? 1_000_000n : 10_000n;
  if (amountMicros % perUnit !== 0n) {
    throw new ValidationError('Validation failed', [
      {
        field: 'amountMicros',
        message: `${amountMicros.toString()} micros of ${currency} is not a whole ${
          ZERO_DECIMAL.has(currency) ? 'unit' : 'minor unit'
        }; refusing to round an invoice amount`,
      },
    ]);
  }
  return amountMicros / perUnit;
}

const customerSchema = z.object({ id: z.string().min(1) });
const setupIntentSchema = z.object({ client_secret: z.string().min(1) });
const paymentIntentSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
});
const errorSchema = z.object({
  error: z.object({ message: z.string().optional(), type: z.string().optional() }).optional(),
});
const eventSchema = z.object({
  type: z.string(),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      last_payment_error: z.object({ message: z.string().optional() }).nullish(),
    }),
  }),
});

function billing(): { secretKey: string; webhookSecret: string; apiBaseUrl: string } {
  const cfg = config.commerceBilling;
  if (cfg.provider !== 'stripe') {
    throw new ServiceUnavailableError('The Stripe billing provider is not configured.');
  }
  return cfg;
}

/** One form-encoded call to Stripe's API. Non-2xx returns the parsed error text, never a guess. */
async function stripeRequest<S extends z.ZodTypeAny>(params: {
  path: string;
  body: Readonly<Record<string, string>>;
  idempotencyKey?: string;
  schema: S;
}): Promise<{ ok: true; data: z.infer<S> } | { ok: false; error: string }> {
  const cfg = billing();
  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.secretKey}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (params.idempotencyKey !== undefined) {
    // The wire-level half of the port's idempotency promise: Stripe dedupes on this header.
    headers['idempotency-key'] = params.idempotencyKey;
  }
  const response = await fetch(`${cfg.apiBaseUrl}${params.path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params.body).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    const parsed = errorSchema.safeParse(JSON.parse(text));
    const message = parsed.success ? parsed.data.error?.message : undefined;
    return { ok: false, error: message ?? `Stripe returned HTTP ${response.status}` };
  }
  const parsed = params.schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`Stripe response did not match the expected shape for ${params.path}`);
  }
  return { ok: true, data: parsed.data };
}

class StripeProvider implements PaymentProvider {
  readonly provider = 'stripe' as const;

  async ensureCustomer(params: {
    orgId: string;
    name: string;
    existingCustomerRef: string | null;
  }): Promise<string> {
    if (params.existingCustomerRef !== null) return params.existingCustomerRef;
    const result = await stripeRequest({
      path: '/v1/customers',
      body: { name: params.name, 'metadata[stewra_org_id]': params.orgId },
      // Keyed on the org: two racing first-charges create ONE customer, not two.
      idempotencyKey: `customer-${params.orgId}`,
      schema: customerSchema,
    });
    if (!result.ok) throw new Error(`Stripe refused to create a customer: ${result.error}`);
    return result.data.id;
  }

  async startPaymentMethodSetup(params: { customerRef: string }): Promise<{ clientSecret: string }> {
    const result = await stripeRequest({
      path: '/v1/setup_intents',
      body: { customer: params.customerRef, 'payment_method_types[]': 'card' },
      schema: setupIntentSchema,
    });
    if (!result.ok) throw new Error(`Stripe refused to start payment-method setup: ${result.error}`);
    return { clientSecret: result.data.client_secret };
  }

  async chargeInvoice(params: {
    invoiceId: string;
    orgId: string;
    amountMicros: bigint;
    currency: string;
    customerRef: string;
    paymentMethodRef: string | null;
    idempotencyKey: string;
  }): Promise<ChargeOutcome> {
    if (params.paymentMethodRef === null) {
      // Refused HERE, before any wire call: an off-session charge with no stored method can only
      // fail at Stripe after creating a dangling intent.
      return { status: 'failed', error: 'The organization has no stored payment method.' };
    }
    const result = await stripeRequest({
      path: '/v1/payment_intents',
      body: {
        amount: stripeAmount(params.amountMicros, params.currency).toString(),
        currency: params.currency.toLowerCase(),
        customer: params.customerRef,
        payment_method: params.paymentMethodRef,
        off_session: 'true',
        confirm: 'true',
        'metadata[stewra_invoice_id]': params.invoiceId,
        'metadata[stewra_org_id]': params.orgId,
      },
      idempotencyKey: params.idempotencyKey,
      schema: paymentIntentSchema,
    });
    if (!result.ok) return { status: 'failed', error: result.error };
    if (result.data.status === 'succeeded') {
      return { status: 'succeeded', providerRef: result.data.id };
    }
    // 'processing', 'requires_action', … — Stripe took the order; the webhook finishes the story.
    return { status: 'pending', providerRef: result.data.id };
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | null): PaymentEvent {
    const cfg = billing();
    if (signatureHeader === null) {
      throw new AuthenticationError('Invalid webhook signature');
    }
    // Stripe-Signature: t=<unix>,v1=<hex hmac of "<t>.<raw body>">. Verified against the RAW
    // bytes, exactly like verifyMetaSignature — a re-serialized JSON body would not match.
    const parts = new Map(
      signatureHeader.split(',').map((p) => {
        const eq = p.indexOf('=');
        return [p.slice(0, eq).trim(), p.slice(eq + 1)] as const;
      }),
    );
    const timestamp = parts.get('t');
    const signature = parts.get('v1');
    if (timestamp === undefined || signature === undefined || !/^[0-9a-f]+$/.test(signature)) {
      throw new AuthenticationError('Invalid webhook signature');
    }
    const expected = createHmac('sha256', cfg.webhookSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest();
    const provided = Buffer.from(signature, 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new AuthenticationError('Invalid webhook signature');
    }

    const parsed = eventSchema.safeParse(JSON.parse(rawBody.toString('utf8')));
    if (!parsed.success) {
      return { kind: 'ignored', reason: 'event shape not recognized' };
    }
    const event = parsed.data;
    if (event.type === 'payment_intent.succeeded') {
      return { kind: 'charge_succeeded', providerRef: event.data.object.id };
    }
    if (event.type === 'payment_intent.payment_failed') {
      return {
        kind: 'charge_failed',
        providerRef: event.data.object.id,
        error: event.data.object.last_payment_error?.message ?? 'payment failed',
      };
    }
    return { kind: 'ignored', reason: `unconsumed event type ${event.type}` };
  }
}

export const stripeProvider = new StripeProvider();
