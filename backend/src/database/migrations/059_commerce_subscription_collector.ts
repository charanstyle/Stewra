import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * WHO COLLECTS the platform fee on a subscription — the one fact migration 053 could not have,
 * because when it was written there was only ever one answer.
 *
 * There are now three, and they are not variations on a theme; they are different parties holding
 * the customer relationship:
 *
 *  - `stewra_stripe` — Stewra issues an invoice and charges a stored card. The document in
 *    `commerce_invoices` IS the bill, and the payment port collects it.
 *  - `apple` / `google` — the store sold the subscription, the store charges the customer, and the
 *    store's own receipt is the bill. Stewra never issues an invoice for that fee and must never
 *    try to charge it; doing so would bill a customer twice for one month. What Stewra holds is an
 *    OBSERVATION of a subscription somebody else owns, kept current from server notifications.
 *
 * This lives on the SUBSCRIPTION rather than the org because it is part of the frozen agreement:
 * the row already records which plan version was in force and when, and "who was billing them"
 * belongs beside it. An org that cancels on the web and re-subscribes through the App Store gets a
 * new subscription row anyway — `setSubscription` ends the old and inserts a fresh one — so the
 * history reads correctly with no extra machinery.
 *
 * The default exists ONLY to backfill: every subscription that predates this column was collected
 * by Stewra, so `stewra_stripe` is the true value for all of them, not a guess. It is dropped
 * immediately afterwards, so a future INSERT that neglects to say who collects fails loudly at the
 * database instead of silently becoming Stewra's problem to bill.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('commerce_subscriptions')
    .addColumn('collector', 'varchar(16)', (col) =>
      col
        .notNull()
        .defaultTo('stewra_stripe')
        .check(sql`collector in ('stewra_stripe', 'apple', 'google')`),
    )
    .execute();

  // Backfill done. From here an insert must name its collector.
  await sql`ALTER TABLE commerce_subscriptions ALTER COLUMN collector DROP DEFAULT;`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('commerce_subscriptions').dropColumn('collector').execute();
}
