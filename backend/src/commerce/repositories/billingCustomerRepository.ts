import type { CommercePaymentProvider } from '@stewra/shared-types';
import { db } from '../../database/index.js';

/**
 * An org's identity at a payment provider (migration 055): the provider's customer ref, and the
 * stored payment-method ref once the client has completed the provider's setup flow.
 */
class BillingCustomerRepository {
  async find(
    orgId: string,
    provider: CommercePaymentProvider,
  ): Promise<{ customerRef: string; paymentMethodRef: string | null } | null> {
    const row = await db
      .selectFrom('commerce_billing_customers')
      .select(['customer_ref', 'payment_method_ref'])
      .where('org_id', '=', orgId)
      .where('provider', '=', provider)
      .executeTakeFirst();
    return row === undefined
      ? null
      : { customerRef: row.customer_ref, paymentMethodRef: row.payment_method_ref };
  }

  /** Record (or re-record) the provider's customer ref. Racing writers converge on one row. */
  async saveCustomerRef(params: {
    orgId: string;
    provider: CommercePaymentProvider;
    customerRef: string;
  }): Promise<void> {
    await db
      .insertInto('commerce_billing_customers')
      .values({
        org_id: params.orgId,
        provider: params.provider,
        customer_ref: params.customerRef,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'provider']).doUpdateSet({
          customer_ref: params.customerRef,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  async savePaymentMethodRef(params: {
    orgId: string;
    provider: CommercePaymentProvider;
    paymentMethodRef: string | null;
  }): Promise<void> {
    await db
      .updateTable('commerce_billing_customers')
      .set({ payment_method_ref: params.paymentMethodRef, updated_at: new Date() })
      .where('org_id', '=', params.orgId)
      .where('provider', '=', params.provider)
      .execute();
  }
}

export const billingCustomerRepository = new BillingCustomerRepository();
