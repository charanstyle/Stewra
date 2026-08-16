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
 * **Entitlement is `active` or `grace_period`, and nothing else.** The other five all describe a
 * customer who still has a subscription object at the store but is not currently paid up:
 * `pending` is a Play purchase whose deferred payment has not cleared, `on_hold` is Google's
 * account hold after a failed payment, `paused` is a Play-side voluntary pause, `expired` ran out,
 * and `revoked` was refunded or pulled. Treating any of them as entitled serves someone who has
 * not paid, which is the expensive direction to be wrong in.
 *
 * `pending` exists rather than being folded into `on_hold` because the two are answers to
 * different questions — "has never paid yet" versus "paid before, and the card just failed" — and
 * a support conversation that cannot tell them apart is a support conversation that guesses.
 */
export const STORE_SUBSCRIPTION_STATUSES = [
  'active',
  'grace_period',
  'pending',
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
  /** Apple `originalTransactionId` / the Google purchase token this state was read for. */
  readonly storeSubscriptionRef: string;
  readonly latestTransactionRef: string | null;
  readonly status: StoreSubscriptionStatus;
  /** End of the paid period. Null only when the store did not say — never inferred. */
  readonly currentPeriodEnd: Date | null;
  readonly autoRenewing: boolean;
  /**
   * The reference this one REPLACES, when the store has re-issued it.
   *
   * Always null for Apple, whose `originalTransactionId` genuinely does survive everything. Google
   * mints a BRAND NEW purchase token on every upgrade, downgrade and resubscribe, and reports the
   * one it supersedes as `linkedPurchaseToken`. Ignoring that field is how an org ends up with two
   * rows for one customer — the old token still looking entitled, the new one unclaimed — so it is
   * carried here and the caller is expected to retire the old row rather than add a second.
   */
  readonly supersedesRef: string | null;
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
      /**
       * The money went back. Carried separately from `subscription` because for Google this is the
       * ONLY channel that reports it: `purchases.subscriptionsv2.get` has no revoked state, and a
       * refunded purchase reads back as merely expired — indistinguishable from one that ran its
       * course. Acting on this needs no current state from the store, only which purchase it was,
       * which is what makes it safe to handle when the lookup itself would 404 on a dead token.
       *
       * Apple never produces this: its refunds arrive as an ordinary notification whose signed
       * transaction carries a `revocationDate`, and are read out of the data like everything else.
       */
      readonly kind: 'revoked';
      readonly notificationRef: string;
      readonly notificationType: string;
      readonly subtype: string | null;
      readonly store: 'apple' | 'google';
      readonly storeSubscriptionRef: string;
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
   * Authenticate a delivery and normalize it. Throws AuthenticationError on anything that does not
   * verify; never partially trusts, and never falls back to trusting the body because the
   * signature was hard to check.
   *
   * Both inputs are here because the two stores authenticate in different places. Apple signs the
   * BODY — the whole proof is in `rawBody`, and the header is nothing. Google does not sign the
   * body at all: a Pub/Sub push is ordinary JSON, and the only proof it came from Google is the
   * OIDC token in `authorization`. A port that carried just the bytes would force the Google
   * adapter to either trust an unsigned body or verify its caller somewhere else, and "the
   * authentication happens in a different file from the parsing" is how a route ends up wired up
   * without it.
   */
  verifyNotification(rawBody: Buffer, authorizationHeader: string | null): Promise<StoreNotification>;

  /**
   * Ask the store about one subscription by its stable reference. This is what turns an app's
   * purchase claim into a fact — the claim supplies the reference and nothing else.
   */
  readSubscription(storeSubscriptionRef: string): Promise<StoreSubscriptionState>;
}
