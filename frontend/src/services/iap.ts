import { Platform } from 'react-native';
import type { Purchase } from 'expo-iap';
import type { CommerceStore } from '@stewra/shared-types';

/**
 * The store side of the in-app subscription, kept out of the screen.
 *
 * Two jobs, both of which are refusals rather than conversions:
 *
 *  - **Which product this build sells.** Read from the environment, not hardcoded, and it throws
 *    at the point of use rather than at app boot. `services/config.ts` deliberately throws at
 *    module load for the API base — an app that cannot reach the backend has no reason to start —
 *    but a build with no store products configured is still a perfectly good chat client, and
 *    turning that into a black screen would be a worse failure than the one it prevents.
 *
 *  - **Which reference identifies the purchase to our server.** This is the whole contract with
 *    `POST /orgs/:orgId/billing/store-purchase`: the app sends a reference and nothing else, and
 *    the server reads every fact back from the store's own API. Sending the wrong reference is the
 *    one mistake here that is silent for a month, so it gets its own function and its own throw.
 */

/**
 * Apple's `originalTransactionId` / Play's `purchaseToken`, and never anything else.
 *
 * Both are typed optional by the library because it shares one shape across five stores, so both
 * are checked. **There is deliberately no fallback to `transactionId` on iOS.** They are the same
 * string for a first purchase, which is exactly what makes the substitution so tempting and so
 * expensive: `transactionId` changes on every renewal, so a row keyed on it stops joining the
 * first time Apple bills the customer again — a month later, silently, on a paying account.
 * Refusing here means an unclaimable purchase and a support ticket; the fallback means a customer
 * who quietly stops being entitled while still paying.
 */
export function purchaseReference(purchase: Purchase): { store: CommerceStore; ref: string } {
  if (Platform.OS === 'ios') {
    const ref = 'originalTransactionIdentifierIOS' in purchase
      ? purchase.originalTransactionIdentifierIOS
      : null;
    if (ref === null || ref === undefined || ref === '') {
      throw new Error(
        'That App Store purchase carries no originalTransactionId, so there is nothing stable to ' +
          'claim it by. Contact support rather than retrying — the purchase itself is fine.',
      );
    }
    return { store: 'apple', ref };
  }
  const ref = purchase.purchaseToken;
  if (ref === null || ref === undefined || ref === '') {
    throw new Error(
      'That Google Play purchase carries no purchaseToken, so there is nothing to claim it by. ' +
        'Contact support rather than retrying — the purchase itself is fine.',
    );
  }
  return { store: 'google', ref };
}

/**
 * The one subscription product this build sells, per platform. Apple's and Play's product ids are
 * issued independently and need not match, so they are separate variables rather than one shared
 * value that would silently be wrong on whichever platform did not choose it.
 *
 * Must equal the backend's `APPLE_STORE_PRODUCT_ID` / `GOOGLE_PLAY_PRODUCT_ID`: the server refuses
 * a claim for any other product, so a mismatch is a purchase the customer pays for and cannot use.
 */
export function storeProductId(): string {
  const id =
    Platform.OS === 'ios'
      ? process.env['EXPO_PUBLIC_STORE_PRODUCT_ID_IOS']
      : process.env['EXPO_PUBLIC_STORE_PRODUCT_ID_ANDROID'];
  if (!id) {
    throw new Error(
      `[iap] Missing ${
        Platform.OS === 'ios'
          ? 'EXPO_PUBLIC_STORE_PRODUCT_ID_IOS'
          : 'EXPO_PUBLIC_STORE_PRODUCT_ID_ANDROID'
      } — this build has no store product to sell. Set it in frontend/.env and rebuild; Expo ` +
        'inlines it at build time, so a restart is not enough.',
    );
  }
  return id;
}

/** True on the two platforms that have a store at all. Web and anything else have no IAP. */
export function storeAvailable(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

/**
 * Where the customer manages or cancels the subscription. Named here so the screen never implies
 * Stewra can cancel it — the store took the money and only the store can stop taking it, which is
 * the same fact the website's billing page states for a store-collected subscription.
 */
export function manageSubscriptionHint(): string {
  return Platform.OS === 'ios'
    ? 'Apple bills this subscription. Your receipts and cancellation live in Settings → Apple Account → Subscriptions.'
    : 'Google Play bills this subscription. Your receipts and cancellation live in the Play Store → Payments and subscriptions.';
}
