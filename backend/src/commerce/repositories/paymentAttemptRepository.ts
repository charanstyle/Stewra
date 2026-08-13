import type { Selectable } from 'kysely';
import type { CommercePaymentAttempt, CommercePaymentProvider } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type { CommercePaymentAttemptsTable } from '../../database/types.js';
import { isUniqueViolation } from '../../database/pgErrors.js';

type AttemptRow = Selectable<CommercePaymentAttemptsTable>;

/** The stored provider column is varchar; anything outside the union is a schema breach worth a crash. */
function toProvider(value: string): CommercePaymentProvider {
  if (value === 'manual' || value === 'stripe') return value;
  throw new Error(`commerce payment attempt carries unknown provider '${value}'`);
}

function toAttempt(row: AttemptRow): CommercePaymentAttempt {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    provider: toProvider(row.provider),
    status: row.status,
    providerRef: row.provider_ref,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The tries at collecting invoices (migration 054). `idempotency_key` is unique across the table:
 * inserting an attempt IS acquiring the right to make that exact charge, so two racing collectors
 * cannot both send the same key to a provider — one of them loses here, before any wire call.
 */
class PaymentAttemptRepository {
  /** Returns null when the idempotency key is already claimed — that charge is someone else's. */
  async create(params: {
    invoiceId: string;
    provider: CommercePaymentProvider;
    idempotencyKey: string;
  }): Promise<CommercePaymentAttempt | null> {
    try {
      const row = await db
        .insertInto('commerce_payment_attempts')
        .values({
          invoice_id: params.invoiceId,
          provider: params.provider,
          status: 'pending',
          idempotency_key: params.idempotencyKey,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toAttempt(row);
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async recordOutcome(params: {
    attemptId: string;
    status: 'succeeded' | 'failed';
    providerRef: string | null;
    error: string | null;
  }): Promise<CommercePaymentAttempt> {
    const row = await db
      .updateTable('commerce_payment_attempts')
      .set({
        status: params.status,
        provider_ref: params.providerRef,
        error: params.error,
        updated_at: new Date(),
      })
      .where('id', '=', params.attemptId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toAttempt(row);
  }

  /** Store the provider's reference on a still-pending attempt — the webhook's only way back. */
  async saveProviderRef(attemptId: string, providerRef: string): Promise<CommercePaymentAttempt> {
    const row = await db
      .updateTable('commerce_payment_attempts')
      .set({ provider_ref: providerRef, updated_at: new Date() })
      .where('id', '=', attemptId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toAttempt(row);
  }

  /** The pending attempt a provider webhook is finishing, found by the provider's own reference. */
  async findPendingByProviderRef(providerRef: string): Promise<CommercePaymentAttempt | null> {
    const row = await db
      .selectFrom('commerce_payment_attempts')
      .selectAll()
      .where('provider_ref', '=', providerRef)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return row === undefined ? null : toAttempt(row);
  }

  async listForInvoice(invoiceId: string): Promise<CommercePaymentAttempt[]> {
    const rows = await db
      .selectFrom('commerce_payment_attempts')
      .selectAll()
      .where('invoice_id', '=', invoiceId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toAttempt);
  }

  /** How many attempts an invoice has, for numbering the next idempotency key. */
  async countForInvoice(invoiceId: string): Promise<number> {
    const row = await db
      .selectFrom('commerce_payment_attempts')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('invoice_id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}

export const paymentAttemptRepository = new PaymentAttemptRepository();
