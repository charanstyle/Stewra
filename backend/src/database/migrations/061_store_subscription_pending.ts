import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Widen the store-subscription vocabulary by one state: `pending`.
 *
 * Migration 060 wrote the status list from what Apple can report. Google can report one more.
 * `SUBSCRIPTION_STATE_PENDING` is a purchase whose payment has not cleared yet — the deferred
 * methods Play supports in several markets, where a customer completes checkout and the money
 * arrives days later, or never.
 *
 * The alternative was to fold it into `on_hold`, and that would have been a lie of exactly the
 * kind this schema keeps refusing to tell. Entitlement is identical — neither is entitled — but
 * the two answer different questions. `on_hold` is a paying customer whose card just failed:
 * chase the card. `pending` has never paid at all: there is nothing to chase, and telling them
 * their payment failed would be wrong. A status column that cannot tell those apart makes every
 * support conversation about it a guess.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    ALTER TABLE commerce_store_subscriptions
    DROP CONSTRAINT IF EXISTS commerce_store_subscriptions_status_check;
  `.execute(db);
  await sql`
    ALTER TABLE commerce_store_subscriptions
    ADD CONSTRAINT commerce_store_subscriptions_status_check
    CHECK (status in ('active', 'grace_period', 'pending', 'on_hold', 'paused', 'expired', 'revoked'));
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // Narrowing back is only safe if nothing is currently in the state being removed. Rewriting
  // those rows to something else would invent an entitlement answer, so this refuses instead.
  const stuck = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM commerce_store_subscriptions WHERE status = 'pending';
  `.execute(db);
  const count = Number(stuck.rows[0]?.count ?? '0');
  if (count > 0) {
    throw new Error(
      `Cannot narrow the store-subscription status list: ${count} row(s) are 'pending'. ` +
        'Resolve them at the store first — this migration will not rewrite them.',
    );
  }
  await sql`
    ALTER TABLE commerce_store_subscriptions
    DROP CONSTRAINT IF EXISTS commerce_store_subscriptions_status_check;
  `.execute(db);
  await sql`
    ALTER TABLE commerce_store_subscriptions
    ADD CONSTRAINT commerce_store_subscriptions_status_check
    CHECK (status in ('active', 'grace_period', 'on_hold', 'paused', 'expired', 'revoked'));
  `.execute(db);
}
