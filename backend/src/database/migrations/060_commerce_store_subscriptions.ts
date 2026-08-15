import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Subscriptions sold by the App Store and Google Play — which is to say, subscriptions Stewra does
 * not own.
 *
 * Everything else in this schema records an agreement Stewra is a party to. These two tables
 * record an OBSERVATION of somebody else's: the store took the customer's money, the store decides
 * when it renews, and the store is the only thing that knows whether it is still live. What is
 * kept here is the current answer to "is this org entitled, and until when", refreshed from that
 * store's server notifications, plus enough of a trail to prove why it says what it says.
 *
 * Three rules shape the columns:
 *
 * **The client is never the source.** A purchase reaches the server as a receipt from an app that
 * could claim anything; that receipt is only a hint about which subscription to go ask the store
 * about. Every field below is written from the store's own API response, never from the app's.
 *
 * **The store's identity, not ours.** `store_subscription_ref` is Apple's `originalTransactionId`
 * or Google's purchase token — the handle that survives renewals, upgrades and resubscribes, and
 * the only thing a notification arriving eighteen months from now will carry. Unique per store,
 * because two orgs claiming one subscription is either a bug or an attempt.
 *
 * **Sandbox is not production.** Apple's sandbox issues real-looking transactions against a fake
 * ledger, and its notifications arrive at the same URL. Recording the environment on the row is
 * what stops a tester's sandbox purchase granting a real entitlement — and it is on the row rather
 * than inferred at read time so the answer cannot change with an env var.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('commerce_store_subscriptions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('store', 'varchar(8)', (col) => col.notNull().check(sql`store in ('apple', 'google')`))
    /** Which ledger this came from. A sandbox row must never grant a production entitlement. */
    .addColumn('environment', 'varchar(10)', (col) =>
      col.notNull().check(sql`environment in ('sandbox', 'production')`),
    )
    /** The store-side product this subscribes to — the $213 listing, in the store's own words. */
    .addColumn('product_id', 'varchar(255)', (col) => col.notNull())
    /**
     * The store's stable identity across the whole life of the subscription: Apple's
     * `originalTransactionId`, Google's purchase token (following `linkedPurchaseToken` back to the
     * root on upgrade/resubscribe). This is the join key every notification arrives with.
     */
    .addColumn('store_subscription_ref', 'varchar(255)', (col) => col.notNull())
    /** The most recent individual transaction — Apple's `transactionId`, Google's `orderId`. */
    .addColumn('latest_transaction_ref', 'varchar(255)')
    /**
     * Normalized across two stores that name things differently. Entitlement is `active` or
     * `grace_period` and nothing else: `on_hold` and `paused` are Google states where the customer
     * keeps the subscription but loses access, and treating them as entitled would serve someone
     * who has stopped paying.
     */
    .addColumn('status', 'varchar(16)', (col) =>
      col
        .notNull()
        .check(
          sql`status in ('active', 'grace_period', 'on_hold', 'paused', 'expired', 'revoked')`,
        ),
    )
    /** When the paid period ends. NULL only before the store has told us — never assumed. */
    .addColumn('current_period_end', 'timestamptz')
    .addColumn('auto_renewing', 'boolean', (col) => col.notNull())
    /**
     * The agreement this observation created, once it has created one. Nullable because the store
     * row is written first — we learn what the store says before deciding what it means — and
     * RESTRICT because a subscription row that an entitlement points at must outlive it.
     */
    .addColumn('subscription_id', 'uuid', (col) =>
      col.references('commerce_subscriptions.id').onDelete('restrict'),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // One row per subscription per store. Two orgs claiming the same purchase is either a bug or
    // somebody replaying a receipt, and both should fail at the database rather than be reconciled.
    .addUniqueConstraint('uq_commerce_store_subscriptions_store_ref', [
      'store',
      'store_subscription_ref',
    ])
    .execute();

  await db.schema
    .createIndex('idx_commerce_store_subscriptions_org')
    .on('commerce_store_subscriptions')
    .column('org_id')
    .execute();

  /**
   * Every notification either store has delivered, so a replay is a no-op and an argument about
   * what we were told has an answer.
   *
   * Apple retries a notification for hours if it does not get a 200, and Pub/Sub redelivers at
   * least once by design — so the same event WILL arrive twice, and the dedupe key has to be the
   * store's own id for it (`notificationUUID` / the Pub/Sub `messageId`) rather than anything
   * derived from the contents, which are identical across a redelivery.
   *
   * The signed payload itself is deliberately NOT stored. It is large, it is replayable, and it
   * carries the customer's transaction history; what is needed to explain a state change is which
   * event said so and when, and that is what is here.
   */
  await db.schema
    .createTable('commerce_store_notifications')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('store', 'varchar(8)', (col) => col.notNull().check(sql`store in ('apple', 'google')`))
    /** The store's own id for this delivery. Unique per store — this IS the replay guard. */
    .addColumn('notification_ref', 'varchar(255)', (col) => col.notNull())
    .addColumn('notification_type', 'varchar(64)', (col) => col.notNull())
    .addColumn('subtype', 'varchar(64)')
    /** Which subscription it concerned, when it concerned one. */
    .addColumn('store_subscription_ref', 'varchar(255)')
    /**
     * False when the delivery verified but named a subscription this install does not know — a
     * foreign or not-yet-claimed purchase. Recorded rather than dropped, because "we were told and
     * did nothing" is the fact worth having when someone asks why an entitlement never appeared.
     */
    .addColumn('applied', 'boolean', (col) => col.notNull())
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_commerce_store_notifications_store_ref', ['store', 'notification_ref'])
    .execute();

  // Evidence, not workpaper: what a store told us is not editable after the fact.
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_store_notifications_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'commerce_store_notifications is append-only: % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_commerce_store_notifications_append_only
    BEFORE UPDATE OR DELETE ON commerce_store_notifications
    FOR EACH ROW EXECUTE FUNCTION stewra_commerce_store_notifications_append_only();
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_commerce_store_notifications_append_only ON commerce_store_notifications;`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS stewra_commerce_store_notifications_append_only();`.execute(db);
  await db.schema.dropTable('commerce_store_notifications').execute();
  await db.schema.dropTable('commerce_store_subscriptions').execute();
}
