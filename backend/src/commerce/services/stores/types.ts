/**
 * The store port — the App Store and Google Play behind one shape.
 *
 * Deliberately narrower than the payment port, because there is far less to do: Stewra never
 * charges, refunds, retries or cancels a store subscription. It can only ever ask two questions.
 *
 *  - "This delivery claims to be from you — is it, and what does it say?" (`verifyNotification`)
 *  - "An app just told me its user bought this. What do YOU say about it?" (`readSubscription`)
 *
 * Both answers come from the store. Neither is ever assembled from what a client sent, which is
 * the single rule this whole directory exists to enforce: a receipt in a request body is a hint
 * about which subscription to go ask about, and nothing more. An app can be decompiled, its
 * traffic replayed, its payloads edited — so the only fact worth writing down is the one the
 * store's own servers gave us, verified against the store's own signature.
 */

/**
 * One vocabulary for two stores that name these differently.
 *
 * **Entitlement is `active` or `grace_period`, and nothing else.** The other four all describe a
 * customer who still has a subscription object at the store but is not currently paid up:
 * `on_hold` is Google's account hold after a failed payment, `paused` is a Play-side voluntary
 * pause, `expired` ran out, and `revoked` was refunded or pulled. Treating any of them as entitled
 * serves someone who has stopped paying, which is the expensive direction to be wrong in.
 */
export const STORE_SUBSCRIPTION_STATUSES = [
  'active',
  'grace_period',
  'on_hold',
  'paused',
  'expired',
  'revoked',
] as const;

export type StoreSubscriptionStatus = (typeof STORE_SUBSCRIPTION_STATUSES)[number];

/** True only for the two states where the customer has actually paid for the period they are in. */
export function isEntitled(status: StoreSubscriptionStatus): boolean {
  return status === 'active' || status === 'grace_period';
}

/** What a store says about one subscription, right now. Every field is the store's, not a client's. */
export interface StoreSubscriptionState {
  readonly store: 'apple' | 'google';
  /**
   * Which ledger this lives on. Carried on every answer rather than read from config at write
   * time, because Apple's sandbox and production notifications arrive at the SAME url, and the
   * only thing that separates a tester's fake purchase from a real one is this field.
   */
  readonly environment: 'sandbox' | 'production';
  readonly productId: string;
  /** Apple `originalTransactionId` / Google purchase token — stable across the subscription's life. */
  readonly storeSubscriptionRef: string;
  readonly latestTransactionRef: string | null;
  readonly status: StoreSubscriptionStatus;
  /** End of the paid period. Null only when the store did not say — never inferred. */
  readonly currentPeriodEnd: Date | null;
  readonly autoRenewing: boolean;
}

/**
 * A verified delivery, translated.
 *
 * `ignored` is first-class for the same reason it is in the payment port: both stores send far
 * more event kinds than this consumes (test pings, price-change consent, renewal-preference
 * changes), and every one of them must be ACKed without being acted on. A store that does not get
 * its 200 retries for hours.
 */
export type StoreNotification =
  | {
      readonly kind: 'subscription';
      /** The store's own id for this delivery — Apple `notificationUUID`, Pub/Sub `messageId`. */
      readonly notificationRef: string;
      readonly notificationType: string;
      readonly subtype: string | null;
      readonly state: StoreSubscriptionState;
    }
  | {
      readonly kind: 'ignored';
      readonly notificationRef: string;
      readonly notificationType: string;
      readonly subtype: string | null;
      readonly reason: string;
    };

export interface StoreProvider {
  readonly store: 'apple' | 'google';

  /**
   * Authenticate a delivery against its RAW bytes and normalize it. Throws AuthenticationError on
   * anything that does not verify; never partially trusts, and never falls back to trusting the
   * body because the signature was hard to check.
   */
  verifyNotification(rawBody: Buffer): Promise<StoreNotification>;

  /**
   * Ask the store about one subscription by its stable reference. This is what turns an app's
   * purchase claim into a fact — the claim supplies the reference and nothing else.
   */
  readSubscription(storeSubscriptionRef: string): Promise<StoreSubscriptionState>;
}
