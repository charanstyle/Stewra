import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getAvailablePurchases, useIAP } from 'expo-iap';
import type { Purchase } from 'expo-iap';
import type {
  CommerceStoreSubscription,
  CommerceSubscriptionView,
  OrgMembership,
} from '@stewra/shared-types';
import { roleMeetsMinimum } from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import {
  manageSubscriptionHint,
  purchaseReference,
  storeAvailable,
  storeProductId,
} from '../../services/iap';
import { theme } from '../../theme/colors';

/**
 * Buying the subscription in the app, and seeing what the store says about it afterwards.
 *
 * **The order of the last two steps is the entire screen.** A completed purchase is claimed with
 * our server FIRST, and only finished at the store once the server has written it down. Finishing
 * first would hand StoreKit or Play its acknowledgement, drop the transaction out of the queue,
 * and leave a customer who has paid with nothing to replay if the claim then failed. An unfinished
 * transaction is redelivered by both stores on every launch until it is acknowledged, which is
 * exactly the retry this needs — so the failure mode of "the claim failed" is "try again later and
 * it still works", rather than "the money is gone".
 *
 * What this screen never does is decide whether the customer is entitled. It renders what
 * `GET /orgs/:orgId/billing` reports, which is what the store told the server. A client that
 * computed entitlement from a local receipt would be a client that could be made to lie by anyone
 * who could edit it — and this one can be edited, because it runs on the customer's phone.
 */

type StoreSubscriptions = ReadonlyArray<CommerceStoreSubscription>;

/**
 * What a failed purchase looks like, structurally.
 *
 * expo-iap exports two `PurchaseError` types that differ in whether `code` is required, and the
 * one reachable from the package root is not the one `useIAP` hands its callback. Declaring the
 * two fields actually read is a supertype of both, so this stays correct whichever the library
 * settles on — and unlike a deep import of `expo-iap/build/...`, it does not reach into a path the
 * package never promised to keep.
 */
interface PurchaseFailure {
  readonly code?: string;
  readonly message: string;
}

export default function SubscriptionScreen(): React.JSX.Element {
  const [memberships, setMemberships] = useState<ReadonlyArray<OrgMembership>>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<CommerceSubscriptionView | null>(null);
  const [storeSubscriptions, setStoreSubscriptions] = useState<StoreSubscriptions>([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Read through a ref inside the purchase callbacks rather than captured: the store's listener is
  // registered once and can fire long after mount (an interrupted purchase is redelivered on the
  // next launch), and a captured org id there would claim it for whichever org was selected then.
  const orgIdRef = useRef<string | null>(null);
  orgIdRef.current = orgId;

  const role = memberships.find((m) => m.org.id === orgId)?.role ?? null;
  const canBuy = role !== null && roleMeetsMinimum(role, 'admin');

  const loadBilling = useCallback(async (id: string): Promise<void> => {
    const billing = await api.getOrgBilling(id);
    setSubscription(billing.subscription);
    setStoreSubscriptions(billing.storeSubscriptions);
  }, []);

  const onPurchaseError = useCallback((err: PurchaseFailure): void => {
    setBusy(false);
    // A cancellation is a decision, not a failure, and reporting it as one trains people to
    // distrust every other message this screen shows.
    setError(err.code === 'user-cancelled' ? null : err.message);
  }, []);

  // Declared before the hook that provides `finishTransaction`, so the claim path reads it from a
  // ref. The alternative — defining the handler inline — puts the claim-then-finish ordering inside
  // a JSX prop, which is the one piece of logic in this file that must be impossible to miss.
  const finishRef = useRef<((args: { purchase: Purchase }) => Promise<void>) | null>(null);

  /**
   * Tell the server about a purchase, then — for a live one — acknowledge it at the store.
   *
   * `finish` is false on the restore path: those transactions were acknowledged the first time
   * they were bought, and finishing one twice is at best a no-op and at worst a way to consume
   * something that should not be consumed.
   */
  const claimPurchase = useCallback(
    async (purchase: Purchase, options: { finish: boolean }): Promise<void> => {
      const id = orgIdRef.current;
      if (id === null) {
        throw new Error(
          'No organization is selected, so there is nothing to attach this purchase to. It stays ' +
            'with the store and will be offered again next time you open this screen.',
        );
      }
      const finish = finishRef.current;
      if (options.finish && finish === null) {
        throw new Error('The store connection is not ready yet. Reopen this screen to try again.');
      }
      const { store, ref } = purchaseReference(purchase);
      const claimed = await api.claimStorePurchase(id, { store, storeSubscriptionRef: ref });
      // Only now. The server has it, so the store may stop redelivering it.
      if (options.finish && finish !== null) await finish({ purchase });
      setSubscription(claimed.subscription);
      setStoreSubscriptions([claimed.storeSubscription]);
      setNotice('Your subscription is active.');
    },
    [],
  );

  /**
   * A purchase that arrived before we knew which organization to attach it to.
   *
   * The store's listener is registered at mount and StoreKit redelivers an unfinished transaction
   * the moment its connection is up — which regularly beats `api.listOrgs()`. Reading a null org id
   * there refused a purchase the customer had already paid for, telling them "No organization is
   * selected", on the first launch after paying. Observed on a real sandbox purchase: the claim
   * lost that race, then succeeded on the next launch when it won it.
   *
   * So it is held rather than refused. Holding is not a fallback path — the org id is on its way,
   * and the only alternative to waiting for it is answering with the wrong one. `busy` stays true
   * across the wait so the screen keeps saying it is working, and the drain effect below claims it
   * the instant the load settles.
   */
  const pendingPurchaseRef = useRef<Purchase | null>(null);
  // Read by the store's callback, which cannot see `loading` freshly: it is registered once and
  // would capture whatever that state was at mount.
  const orgLoadSettledRef = useRef(false);
  // A held purchase must NOT be claimed after a failed load. `orgId` ends up null for two different
  // reasons — this account has no business, and we could not find out — and only the first is a
  // true thing to tell someone about their purchase. On a failed load the transaction stays
  // unfinished and the store redelivers it next launch, which is the retry this screen is built on.
  const orgLoadFailedRef = useRef(false);

  const runClaim = useCallback(
    (purchase: Purchase): void => {
      claimPurchase(purchase, { finish: true })
        .catch((err: unknown) => {
          // Deliberately NOT finished. The store keeps the transaction and redelivers it, so both
          // the customer's money and their entitlement are still recoverable on the next launch.
          const detail =
            err instanceof ApiError || err instanceof Error
              ? err.message
              : 'That purchase could not be confirmed.';
          setError(`${detail} Your purchase is safe — the store will offer it again.`);
        })
        .finally(() => setBusy(false));
    },
    [claimPurchase],
  );

  const onPurchaseSuccess = useCallback(
    (purchase: Purchase): void => {
      setBusy(true);
      setError(null);
      if (!orgLoadSettledRef.current) {
        pendingPurchaseRef.current = purchase;
        return;
      }
      runClaim(purchase);
    },
    [runClaim],
  );

  /**
   * Restore — required by App Review for any subscription app, and genuinely needed: after a
   * reinstall or on a second device the store still has the subscription, but this install has
   * never told the server about it.
   *
   * The store is asked what this Apple ID / Play account actually owns; the claim then verifies
   * each one server-side, exactly as a fresh purchase would be. Nothing here reads a local receipt
   * and concludes anything from it.
   */
  const restore = useCallback((): void => {
    setError(null);
    setNotice(null);
    setBusy(true);
    void (async () => {
      try {
        const owned = await getAvailablePurchases();
        const sku = storeProductId();
        const mine = owned.filter((p) => p.productId === sku);
        if (mine.length === 0) {
          setNotice('This store account has no subscription to restore.');
          return;
        }
        for (const purchase of mine) {
          await claimPurchase(purchase, { finish: false });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nothing could be restored.');
      } finally {
        setBusy(false);
      }
    })();
  }, [claimPurchase]);

  const { connected, subscriptions, fetchProducts, requestPurchase, finishTransaction } = useIAP({
    onPurchaseSuccess,
    onPurchaseError,
  });
  finishRef.current = finishTransaction;

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.listOrgs();
        setMemberships(res.memberships);
        const id = res.activeOrgId ?? res.memberships[0]?.org.id ?? null;
        // Publish to the ref here, not just via the re-render `setOrgId` schedules. The store's
        // callback reads the ref and is gated on `orgLoadSettledRef`, which is set in the `finally`
        // below — so leaving the ref to the next render leaves a window where the callback is told
        // the org is known and then reads null. Narrow, but it is the same race this whole block
        // exists to close.
        orgIdRef.current = id;
        setOrgId(id);
        if (id !== null) await loadBilling(id);
      } catch (err) {
        orgLoadFailedRef.current = true;
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        // Set with `loading`, and for the same moment: the callback reads the ref, the effect below
        // reads the state, and they must never disagree about whether the org is known.
        orgLoadSettledRef.current = true;
        setLoading(false);
      }
    })();
  }, [loadBilling]);

  /**
   * Claim a purchase that arrived before the org did — see `pendingPurchaseRef`.
   *
   * Keyed on `loading` so it fires the instant the org load settles, and on `orgId` so a purchase
   * held across an org switch is attached to the org that is selected now rather than the one that
   * happened to be selected when the store redelivered it.
   */
  useEffect(() => {
    if (loading) return;
    const held = pendingPurchaseRef.current;
    if (held === null) return;
    if (orgLoadFailedRef.current) {
      // The load's own error is already on screen and is the true reason. Leave it there rather
      // than replacing it with a claim failure that would name the wrong cause, and leave the
      // purchase with the store, which redelivers it next launch.
      setBusy(false);
      return;
    }
    pendingPurchaseRef.current = null;
    runClaim(held);
  }, [loading, orgId, runClaim]);

  // Ask the store about the product only once its connection is up: `fetchProducts` before the
  // billing client has connected returns nothing on Android, which would render as "no price" for
  // a product that is perfectly available.
  useEffect(() => {
    if (!connected || !storeAvailable()) return;
    try {
      void fetchProducts({ skus: [storeProductId()], type: 'subs' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  }, [connected, fetchProducts]);

  const product = subscriptions[0] ?? null;
  const storeSubscription = storeSubscriptions[0] ?? null;
  const entitled =
    storeSubscription !== null &&
    (storeSubscription.status === 'active' || storeSubscription.status === 'grace_period');

  const buy = useCallback((): void => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const sku = storeProductId();
      // Android's billing flow needs the offer token the store handed back with the product. There
      // is no correct default for it, so a product that arrived without one is asked for plainly
      // rather than with a fabricated offer.
      const offers = product === null ? [] : (product.subscriptionOffers ?? []);
      const offerToken = offers[0]?.offerTokenAndroid ?? null;
      void requestPurchase({
        type: 'subs',
        request: {
          apple: { sku },
          google:
            offerToken === null
              ? { skus: [sku] }
              : { skus: [sku], subscriptionOffers: [{ sku, offerToken }] },
        },
      });
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  }, [product, requestPurchase]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content} testID="subscription-screen">
        {error !== null && (
          <Text style={styles.error} testID="subscription-error">
            {error}
          </Text>
        )}
        {notice !== null && (
          <Text style={styles.notice} testID="subscription-notice">
            {notice}
          </Text>
        )}

        <View style={styles.card} testID="subscription-plan-card">
          <Text style={styles.cardTitle}>Your plan</Text>
          {orgId === null ? (
            // Distinct from "no plan" on purpose: an account with no business at all and a business
            // with no plan are different problems, and one message for both sends the first person
            // looking for a Subscribe button that could never appear.
            <Text style={styles.muted}>
              You are not part of a business yet. Create one on the web, then come back here.
            </Text>
          ) : subscription === null ? (
            <Text style={styles.muted}>This organization is not on a plan yet.</Text>
          ) : (
            <>
              <Text style={styles.body} testID="subscription-plan">
                <Text style={styles.strong}>{subscription.planName}</Text> — version{' '}
                {subscription.planVersion}, in force since{' '}
                {new Date(subscription.startedAt).toLocaleDateString()}.
              </Text>
              {(subscription.collector === 'apple' || subscription.collector === 'google') && (
                <Text style={styles.muted}>{manageSubscriptionHint()}</Text>
              )}
            </>
          )}
        </View>

        {storeSubscription !== null && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>What the store says</Text>
            <Text style={styles.body} testID="store-subscription-status">
              {describeStatus(storeSubscription)}
            </Text>
            {storeSubscription.environment === 'sandbox' && (
              // Worth saying out loud. A sandbox row is a tester's purchase and grants nothing on a
              // production install; rendering it as an ordinary subscription is how somebody ships
              // a build believing entitlement works.
              <Text style={styles.warn}>
                This is a sandbox purchase. It is not a real subscription.
              </Text>
            )}
            {!storeSubscription.autoRenewing && (
              <Text style={styles.muted}>
                Auto-renew is off. Access continues until the date above.
              </Text>
            )}
          </View>
        )}

        {storeAvailable() && canBuy && (
          // Always offered, entitled or not. App Review requires it, and the case it exists for is
          // precisely the one where this screen currently shows nothing: a reinstall, or a second
          // device, where the store still has the subscription and this install has never told the
          // server about it.
          <Pressable
            style={[styles.linkButton, busy && styles.buttonDisabled]}
            onPress={restore}
            disabled={busy}
            testID="restore-purchases"
          >
            <Text style={styles.linkButtonText}>Restore purchases</Text>
          </Pressable>
        )}

        {!storeAvailable() ? (
          <Text style={styles.muted}>In-app purchases are not available on this device.</Text>
        ) : entitled ? null : !canBuy ? (
          <Text style={styles.muted}>
            Only an owner or admin of this organization can buy the subscription.
          </Text>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Subscribe</Text>
            {product === null ? (
              <Text style={styles.muted}>
                {connected
                  ? 'The store has no price for this product yet.'
                  : 'Connecting to the store…'}
              </Text>
            ) : (
              <>
                <Text style={styles.price} testID="subscription-price">
                  {product.displayPrice}
                </Text>
                <Text style={styles.muted}>{product.description}</Text>
                <Pressable
                  style={[styles.button, busy && styles.buttonDisabled]}
                  onPress={buy}
                  disabled={busy}
                  testID="subscribe-button"
                >
                  <Text style={styles.buttonText}>{busy ? 'Working…' : 'Subscribe'}</Text>
                </Pressable>
              </>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** The store's status in the words a customer would use, not the enum's. */
function describeStatus(s: CommerceStoreSubscription): string {
  const until =
    s.currentPeriodEnd === null ? null : new Date(s.currentPeriodEnd).toLocaleDateString();
  switch (s.status) {
    case 'active':
      return until === null
        ? 'Active.'
        : `Active${s.autoRenewing ? ', renews' : ', ends'} ${until}.`;
    case 'grace_period':
      return `Payment failed — access continues${
        until === null ? '' : ` until ${until}`
      } while the store retries the card.`;
    case 'pending':
      return 'Waiting for the payment to clear. Access starts once it does.';
    case 'on_hold':
      return 'On hold — the store could not charge the card. Access has stopped until it is fixed.';
    case 'paused':
      return 'Paused at the store. Access has stopped until it is resumed.';
    case 'expired':
      return until === null ? 'Expired.' : `Expired on ${until}.`;
    case 'revoked':
      return 'Refunded or withdrawn by the store. Access has stopped.';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    padding: theme.spacing.md,
    gap: theme.spacing.md,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  cardTitle: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  body: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  strong: {
    fontWeight: '600',
  },
  muted: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  warn: {
    color: theme.colors.warning,
    fontSize: 13,
    lineHeight: 19,
  },
  price: {
    color: theme.colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
  },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  linkButton: {
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
  },
  linkButtonText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonText: {
    color: theme.colors.background,
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: theme.colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  notice: {
    color: theme.colors.success,
    fontSize: 14,
    lineHeight: 20,
  },
});
