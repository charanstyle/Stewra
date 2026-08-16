import type { Selectable } from 'kysely';
import type { CommerceStore, CommerceStoreSubscription } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type { CommerceStoreSubscriptionsTable } from '../../database/types.js';
import type { StoreSubscriptionState } from '../services/stores/types.js';

/**
 * The store-subscription tables (migrations 060–061): what each store says about a subscription it
 * sold, and every delivery it has made saying so.
 *
 * Two things this deliberately does NOT do.
 *
 * It never writes a status, a period end or a product from anything but a `StoreSubscriptionState`
 * — the shape the store port produces and only the store port produces. There is no `setStatus`,
 * because a caller holding one would eventually be a caller that decided a status for itself.
 *
 * And it never *deletes*. A store subscription that lapses becomes `expired` or `revoked` and
 * stays; `commerce_store_notifications` is append-only by trigger. What a store told us is
 * evidence, and the only correct answer to "why did this org lose access" is the row that says so.
 */

type StoreSubscriptionRow = Selectable<CommerceStoreSubscriptionsTable>;

function toView(row: StoreSubscriptionRow): CommerceStoreSubscription {
  return {
    id: row.id,
    orgId: row.org_id,
    store: row.store,
    environment: row.environment,
    productId: row.product_id,
    storeSubscriptionRef: row.store_subscription_ref,
    latestTransactionRef: row.latest_transaction_ref,
    status: row.status,
    currentPeriodEnd: row.current_period_end === null ? null : row.current_period_end.toISOString(),
    autoRenewing: row.auto_renewing,
    subscriptionId: row.subscription_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

class StoreSubscriptionRepository {
  // --- Notifications ----------------------------------------------------------------------------

  /**
   * Has this exact delivery already been handled? Apple retries for hours without a 200 and
   * Pub/Sub redelivers at least once by design, so the same event WILL arrive twice.
   *
   * This is a read, and the write that follows it is what actually enforces uniqueness — two
   * concurrent redeliveries can both read `false`, both apply the same store-supplied state (which
   * is idempotent: it writes what the store says, not a delta), and then exactly one of them wins
   * the insert. Checking first is the cheap path for the ordinary replay; the constraint is the
   * correct one for the race.
   */
  async notificationSeen(store: CommerceStore, notificationRef: string): Promise<boolean> {
    const row = await db
      .selectFrom('commerce_store_notifications')
      .select('id')
      .where('store', '=', store)
      .where('notification_ref', '=', notificationRef)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Record that a delivery arrived and what became of it. `doNothing` on conflict: the losing side
   * of a redelivery race is not an error, and the table's trigger forbids updating the row anyway.
   */
  async recordNotification(params: {
    store: CommerceStore;
    notificationRef: string;
    notificationType: string;
    subtype: string | null;
    storeSubscriptionRef: string | null;
    applied: boolean;
  }): Promise<void> {
    await db
      .insertInto('commerce_store_notifications')
      .values({
        store: params.store,
        notification_ref: params.notificationRef,
        notification_type: params.notificationType,
        subtype: params.subtype,
        store_subscription_ref: params.storeSubscriptionRef,
        applied: params.applied,
      })
      .onConflict((oc) => oc.columns(['store', 'notification_ref']).doNothing())
      .execute();
  }

  // --- Subscriptions ----------------------------------------------------------------------------

  async findByRef(
    store: CommerceStore,
    storeSubscriptionRef: string,
  ): Promise<CommerceStoreSubscription | null> {
    const row = await db
      .selectFrom('commerce_store_subscriptions')
      .selectAll()
      .where('store', '=', store)
      .where('store_subscription_ref', '=', storeSubscriptionRef)
      .executeTakeFirst();
    return row === undefined ? null : toView(row);
  }

  /** Every store subscription an org holds. Normally none or one; two only if they bought on both. */
  async listForOrg(orgId: string): Promise<CommerceStoreSubscription[]> {
    const rows = await db
      .selectFrom('commerce_store_subscriptions')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toView);
  }

  /**
   * First write for a purchase: the org claiming it, and the store's own answer about it.
   *
   * No `onConflict`. The unique `(store, store_subscription_ref)` is the tenancy guard — a second
   * org claiming a purchase that is already claimed must fail, not merge — and the caller turns
   * that failure into a refusal the claimant can read.
   */
  async insertClaim(params: {
    orgId: string;
    state: StoreSubscriptionState;
  }): Promise<CommerceStoreSubscription> {
    const row = await db
      .insertInto('commerce_store_subscriptions')
      .values({
        org_id: params.orgId,
        store: params.state.store,
        environment: params.state.environment,
        product_id: params.state.productId,
        store_subscription_ref: params.state.storeSubscriptionRef,
        latest_transaction_ref: params.state.latestTransactionRef,
        status: params.state.status,
        current_period_end: params.state.currentPeriodEnd,
        auto_renewing: params.state.autoRenewing,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toView(row);
  }

  /**
   * Overwrite what we believe about a purchase with what the store just said.
   *
   * `store` and `environment` are not in the SET list and cannot be: they are the row's identity
   * and its ledger, and a state that disagreed with either would be a state for a different
   * subscription. The port already refuses a payload from the wrong ledger, so this cannot happen —
   * the columns being unwritable is the second lock.
   */
  async updateState(state: StoreSubscriptionState): Promise<CommerceStoreSubscription | null> {
    const row = await db
      .updateTable('commerce_store_subscriptions')
      .set({
        product_id: state.productId,
        latest_transaction_ref: state.latestTransactionRef,
        status: state.status,
        current_period_end: state.currentPeriodEnd,
        auto_renewing: state.autoRenewing,
        updated_at: new Date(),
      })
      .where('store', '=', state.store)
      .where('store_subscription_ref', '=', state.storeSubscriptionRef)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toView(row);
  }

  /**
   * The one status written without a `StoreSubscriptionState`, and the reason it has to be:
   * `purchases.subscriptionsv2.get` has no revoked state at all. A refunded Play purchase reads
   * back as merely *expired* — indistinguishable from one that ran its course — and often 404s
   * outright once the token is void. So the refund notification is the only channel that ever
   * reports it, and acting on it must not require going back to ask.
   *
   * `auto_renewing` goes false with it: money that has been returned is not renewing.
   */
  async markRevoked(id: string): Promise<CommerceStoreSubscription | null> {
    const row = await db
      .updateTable('commerce_store_subscriptions')
      .set({ status: 'revoked', auto_renewing: false, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toView(row);
  }

  /**
   * Move a row forward onto a re-issued purchase token — Google only, and the reason
   * `store_subscription_ref` is writable at all.
   *
   * Play mints a new token on every upgrade, downgrade and resubscribe and names the old one as
   * `linkedPurchaseToken`. Inserting a second row instead would leave the superseded token still
   * reading entitled and the new one unclaimed by anybody, which is one customer holding two
   * subscriptions and one org that cannot be billed correctly for either.
   *
   * Returns false when there was nothing to move — a first purchase, or one this install never
   * saw. The caller treats that as "not ours yet", not as an error.
   */
  async rekey(params: { store: CommerceStore; fromRef: string; toRef: string }): Promise<boolean> {
    const row = await db
      .updateTable('commerce_store_subscriptions')
      .set({ store_subscription_ref: params.toRef, updated_at: new Date() })
      .where('store', '=', params.store)
      .where('store_subscription_ref', '=', params.fromRef)
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Point the observation at the plan tenure it created, or unpoint it when the subscription
   * lapses. Null on lapse is load-bearing: a row still pointing at an ended tenure would make the
   * next renewal look already-granted and the org would never be re-subscribed.
   */
  async setSubscriptionId(id: string, subscriptionId: string | null): Promise<void> {
    await db
      .updateTable('commerce_store_subscriptions')
      .set({ subscription_id: subscriptionId, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }
}

export const storeSubscriptionRepository = new StoreSubscriptionRepository();
