import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The bridge between an org and its identity at a payment provider (migration 054 built the
 * documents; this is who pays them). One row per (org, provider): the provider's customer
 * reference, and — once a card or mandate has been stored through the provider's own flow — the
 * payment method reference charges are made with.
 *
 * Deliberately NOT a credential: both refs are opaque provider-side identifiers, useless without
 * the install's secret key, which lives in env. Nothing here goes through the vault for the same
 * reason a Stripe customer id appears in Stripe's own dashboard URLs.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('commerce_billing_customers')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    /** Which provider this identity lives at — the same closed union the payment port carries. */
    .addColumn('provider', 'varchar(32)', (col) =>
      col.notNull().check(sql`provider in ('manual', 'stripe')`),
    )
    .addColumn('customer_ref', 'varchar(255)', (col) => col.notNull())
    /** NULL until the client completes the provider's payment-method setup flow. A charge without
     *  one is refused before the provider is ever called. */
    .addColumn('payment_method_ref', 'varchar(255)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_commerce_billing_customers_org_provider', ['org_id', 'provider'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_billing_customers').execute();
}
