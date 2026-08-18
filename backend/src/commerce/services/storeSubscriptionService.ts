import type { CommerceStore, CommerceStoreSubscription } from '@stewra/shared-types';
import { isEntitled } from '@stewra/shared-types';
import { config } from '../../config/unifiedConfig.js';
import { planRepository } from '../repositories/planRepository.js';
import { storeSubscriptionRepository } from '../repositories/storeSubscriptionRepository.js';
import { buildStoreProvider, storeProductId } from './stores/index.js';
import type { StoreNotification } from './stores/types.js';
import { NotFoundError, ServiceUnavailableError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Where a store's word becomes this install's state.
 *
 * The whole plane above this file is built on one rule: **the client is never the source.** A
 * purchase reaches the server as a receipt from an app that can be decompiled and whose traffic can
 * be replayed, so a receipt is a HINT about which subscription to go ask the store about, and
 * nothing more. Both entry points here honour that in the same way — the claim endpoint reads the
 * state back from the store's own API, and the webhook reads it out of a delivery the store's own
 * signature (or OIDC token) has already been proven to have produced.
 *
 * What this adds on top of the port is the part the port deliberately refuses to know: what a
 * verified subscription MEANS. Which product this install actually sells, which plan the purchase
 * buys, and when an org gains or loses that plan. The port proves the store said it; this decides
 * what to do about it.
 */

/** What became of one verified delivery. Every value is an ordinary outcome, not an error. */
export type StoreNotificationOutcome =
  /** Applied to a subscription this install knows. */
  | 'applied'
  /** Already handled — Apple retried, or Pub/Sub redelivered. */
  | 'replay'
  /** Verified, but carries no subscription: a test ping, a price-consent prompt. */
  | 'ignored'
  /** Verified and about a real subscription, but not one any org here has claimed yet. */
  | 'unclaimed'
  /** Verified, ours, and about a product this install does not sell. */
  | 'foreign_product';

class StoreSubscriptionService {
  /**
   * Prove at boot that a verified purchase would actually buy something.
   *
   * `COMMERCE_STORE_PLAN_NAME` is free text matched against `commerce_plans.name`, and the config
   * guard can only check that somebody typed one. A typo, a plan renamed in the catalog, or an
   * install whose catalog was never loaded all leave a store-enabled backend that boots clean,
   * lists a subscription, lets the store take the customer's money — and only then discovers it has
   * nothing to grant. `reconcileEntitlement` does refuse loudly at that point, but by then the
   * charge has happened. This is the same refusal moved to where it costs nothing: the operator's
   * terminal, before anyone can pay.
   *
   * Existence is not the whole question. `setSubscription` writes against a plan's LATEST VERSION,
   * so a plan row carrying no versions is a name that resolves and still grants nothing.
   *
   * No-op unless a store is enabled — an install that sells only through Stripe has no plan name
   * to check and must not be held to one.
   */
  async assertStorePlanLoaded(): Promise<void> {
    if (!config.appleStore.enabled && !config.googlePlay.enabled) return;

    const planName = config.commerceStorePlanName;
    if (planName === null) {
      // Unreachable: the post-parse guard in unifiedConfig refuses this pair. If it ever throws,
      // that guard has a hole — and the hole is worth the crash either way.
      throw new Error(
        'A store is enabled but COMMERCE_STORE_PLAN_NAME is not set, so a verified purchase would ' +
          'have nothing to buy.',
      );
    }

    const catalog = await planRepository.listPlans();
    const match = catalog.find((entry) => entry.plan.name === planName);
    if (match === undefined) {
      // What the operator is told next is the whole value of this refusal. The lookup is an exact
      // string match, so the mismatch that actually happens is a case or whitespace difference —
      // invisible reading the env file, obvious the moment both spellings sit on one line.
      const fold = (name: string): string => name.trim().toLowerCase();
      const near = catalog.find((entry) => fold(entry.plan.name) === fold(planName));
      const NAMES_SHOWN = 10;
      const rest = catalog.length - NAMES_SHOWN;
      const hint =
        catalog.length === 0
          ? 'No plans are loaded at all — load one with PUT /api/platform/billing/plans.'
          : near !== undefined
            ? `Did you mean "${near.plan.name}"? The match is exact, case and spacing included.`
            : `Loaded plans: ${catalog
                .slice(0, NAMES_SHOWN)
                .map((entry) => `"${entry.plan.name}"`)
                .join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.`;
      throw new Error(
        `COMMERCE_STORE_PLAN_NAME="${planName}" names no plan in this install's catalog, so every ` +
          `store purchase would verify and grant nothing. ${hint}`,
      );
    }
    if (match.versions.length === 0) {
      throw new Error(
        `COMMERCE_STORE_PLAN_NAME="${planName}" names a plan that has no versions. A subscription ` +
          'is written against a plan VERSION, so a purchase would verify and grant nothing.',
      );
    }

    logger.info('commerce stores: the plan a store purchase buys is loaded', {
      planName,
      planId: match.plan.id,
      versions: match.versions.length,
    });
  }

  /** Every store subscription an org holds — what the billing page renders the store section from. */
  async listForOrg(orgId: string): Promise<CommerceStoreSubscription[]> {
    return storeSubscriptionRepository.listForOrg(orgId);
  }

  /**
   * An app says its user bought this. Go and ask the store.
   *
   * The request body supplies exactly one thing — a reference — and every fact written comes back
   * from `readSubscription`. A forged body can therefore only ever name a purchase; it cannot
   * describe one, which is what makes "the app is hostile" a survivable assumption rather than a
   * problem to mitigate.
   *
   * Four refusals, in order, each for a different attack or mistake:
   *  1. The store must know the purchase at all (the port throws for a 404 on this install's ledger,
   *     which also covers a sandbox receipt sent to a production install).
   *  2. It must be the product this install sells — otherwise shipping a cheaper tier later would
   *     silently grant the full plan.
   *  3. It must be currently paid up. A claim for an expired or refunded purchase buys nothing.
   *  4. It must not already belong to somebody else. Purchase references are guessable-adjacent
   *     (they travel through the app, the store, and any proxy in between), so the unique
   *     constraint is the real guard and this is the readable refusal in front of it.
   */
  async claimPurchase(params: {
    orgId: string;
    store: CommerceStore;
    storeSubscriptionRef: string;
  }): Promise<CommerceStoreSubscription> {
    const provider = buildStoreProvider(params.store);
    const state = await provider.readSubscription(params.storeSubscriptionRef);

    const expectedProduct = storeProductId(params.store);
    if (state.productId !== expectedProduct) {
      throw new ValidationError('Validation failed', [
        {
          field: 'storeSubscriptionRef',
          message: `That purchase is for product ${state.productId}; this install sells ${expectedProduct}.`,
        },
      ]);
    }
    if (!isEntitled(state.status)) {
      throw new ValidationError('Validation failed', [
        {
          field: 'storeSubscriptionRef',
          message: `The store reports that subscription as ${state.status}, so there is nothing to grant.`,
        },
      ]);
    }

    // Play may already have re-issued the token between the purchase and this claim (an upgrade
    // during onboarding is enough). Follow the link forward before looking, or the row we own would
    // be invisible under its old key and this would look like a fresh, unclaimed purchase.
    if (state.supersedesRef !== null) {
      const moved = await storeSubscriptionRepository.rekey({
        store: params.store,
        fromRef: state.supersedesRef,
        toRef: state.storeSubscriptionRef,
      });
      if (moved) {
        logger.info('commerce stores: re-keyed a purchase onto its replacement token', {
          store: params.store,
          fromRef: state.supersedesRef,
          toRef: state.storeSubscriptionRef,
        });
      }
    }

    const existing = await storeSubscriptionRepository.findByRef(
      params.store,
      state.storeSubscriptionRef,
    );
    if (existing !== null && existing.orgId !== params.orgId) {
      throw new ValidationError('Validation failed', [
        {
          field: 'storeSubscriptionRef',
          message: 'That purchase is already claimed by another organization.',
        },
      ]);
    }

    let row: CommerceStoreSubscription;
    if (existing === null) {
      try {
        row = await storeSubscriptionRepository.insertClaim({ orgId: params.orgId, state });
      } catch (error) {
        // Two orgs claiming at once: the constraint decided, and the loser gets the same readable
        // refusal as if it had arrived a second later. Re-read rather than parse a driver error
        // code — the question "who owns it now" has an answer, and that answer is the message.
        const raced = await storeSubscriptionRepository.findByRef(
          params.store,
          state.storeSubscriptionRef,
        );
        if (raced !== null && raced.orgId !== params.orgId) {
          throw new ValidationError('Validation failed', [
            {
              field: 'storeSubscriptionRef',
              message: 'That purchase is already claimed by another organization.',
            },
          ]);
        }
        throw error;
      }
    } else {
      const updated = await storeSubscriptionRepository.updateState(state);
      if (updated === null) throw new NotFoundError('That store subscription no longer exists.');
      row = updated;
    }

    await this.reconcileEntitlement(row);
    const settled = await storeSubscriptionRepository.findByRef(
      params.store,
      state.storeSubscriptionRef,
    );
    if (settled === null) throw new NotFoundError('That store subscription no longer exists.');
    logger.info('commerce stores: purchase claimed', {
      orgId: params.orgId,
      store: params.store,
      status: settled.status,
      environment: settled.environment,
      subscriptionId: settled.subscriptionId,
    });
    return settled;
  }

  /**
   * Apply one already-verified delivery.
   *
   * Verification happened in the port, before this was called and before the body was believed —
   * see `storeWebhookController`. Nothing here re-checks a signature, and nothing here may: a
   * function that could be reached with an unverified notification is a function that eventually
   * will be.
   *
   * Every path records the delivery, including the ones that change nothing. "We were told and did
   * nothing, because no org had claimed that purchase" is precisely the fact worth having when
   * somebody asks why an entitlement never appeared.
   */
  async applyNotification(
    store: CommerceStore,
    notification: StoreNotification,
  ): Promise<StoreNotificationOutcome> {
    if (await storeSubscriptionRepository.notificationSeen(store, notification.notificationRef)) {
      logger.info('commerce stores: notification already handled', {
        store,
        notificationRef: notification.notificationRef,
        notificationType: notification.notificationType,
      });
      return 'replay';
    }

    if (notification.kind === 'ignored') {
      await storeSubscriptionRepository.recordNotification({
        store,
        notificationRef: notification.notificationRef,
        notificationType: notification.notificationType,
        subtype: notification.subtype,
        storeSubscriptionRef: null,
        applied: false,
      });
      logger.info('commerce stores: notification carried no subscription', {
        store,
        notificationType: notification.notificationType,
        reason: notification.reason,
      });
      return 'ignored';
    }

    if (notification.kind === 'revoked') {
      const row = await storeSubscriptionRepository.findByRef(
        store,
        notification.storeSubscriptionRef,
      );
      const applied = row !== null;
      if (row !== null) {
        // No lookup. A voided purchase reads back as merely expired, or 404s outright — the
        // notification is the only thing that will ever say the money went back.
        const revoked = await storeSubscriptionRepository.markRevoked(row.id);
        if (revoked !== null) await this.reconcileEntitlement(revoked);
        logger.warn('commerce stores: subscription revoked by the store', {
          store,
          orgId: row.orgId,
          storeSubscriptionRef: notification.storeSubscriptionRef,
          notificationType: notification.notificationType,
        });
      }
      await storeSubscriptionRepository.recordNotification({
        store,
        notificationRef: notification.notificationRef,
        notificationType: notification.notificationType,
        subtype: notification.subtype,
        storeSubscriptionRef: notification.storeSubscriptionRef,
        applied,
      });
      return applied ? 'applied' : 'unclaimed';
    }

    const state = notification.state;
    const expectedProduct = storeProductId(store);
    if (state.productId !== expectedProduct) {
      // Same install, same signature, different product. ACKed and recorded rather than refused:
      // the store is not wrong to have sent it, and a 500 here would have it retried for hours.
      await storeSubscriptionRepository.recordNotification({
        store,
        notificationRef: notification.notificationRef,
        notificationType: notification.notificationType,
        subtype: notification.subtype,
        storeSubscriptionRef: state.storeSubscriptionRef,
        applied: false,
      });
      logger.warn('commerce stores: notification names a product this install does not sell', {
        store,
        productId: state.productId,
        expectedProduct,
      });
      return 'foreign_product';
    }

    if (state.supersedesRef !== null) {
      const moved = await storeSubscriptionRepository.rekey({
        store,
        fromRef: state.supersedesRef,
        toRef: state.storeSubscriptionRef,
      });
      if (moved) {
        logger.info('commerce stores: re-keyed a purchase onto its replacement token', {
          store,
          fromRef: state.supersedesRef,
          toRef: state.storeSubscriptionRef,
        });
      }
    }

    const updated = await storeSubscriptionRepository.updateState(state);
    if (updated !== null) await this.reconcileEntitlement(updated);
    await storeSubscriptionRepository.recordNotification({
      store,
      notificationRef: notification.notificationRef,
      notificationType: notification.notificationType,
      subtype: notification.subtype,
      storeSubscriptionRef: state.storeSubscriptionRef,
      applied: updated !== null,
    });
    if (updated === null) {
      logger.info('commerce stores: notification names a purchase no organization has claimed', {
        store,
        storeSubscriptionRef: state.storeSubscriptionRef,
        notificationType: notification.notificationType,
      });
      return 'unclaimed';
    }
    logger.info('commerce stores: subscription state updated from a store notification', {
      store,
      orgId: updated.orgId,
      status: updated.status,
      notificationType: notification.notificationType,
    });
    return 'applied';
  }

  /**
   * Make the org's plan agree with what the store says about its subscription.
   *
   * This is the only place a store observation turns into (or out of) an agreement, and it is
   * driven entirely by `isEntitled` — never by a notification type. Apple has added notification
   * types repeatedly and Play renumbers its own; a switch over their names is a thing that silently
   * stops covering cases, whereas "is this customer paid up right now" has not changed shape.
   *
   * The `subscription_id` link is what makes it idempotent from both directions: a renewal arriving
   * every month finds the tenure already there and writes nothing, and a lapse clears the link so
   * the NEXT successful renewal grants again rather than seeing a stale pointer and skipping.
   */
  private async reconcileEntitlement(row: CommerceStoreSubscription): Promise<void> {
    const collector = row.store; // 'apple' | 'google' — the collector vocabulary is the same.

    if (isEntitled(row.status)) {
      if (row.subscriptionId !== null) return;
      const planName = config.commerceStorePlanName;
      if (planName === null) {
        // Unreachable: the boot guard refuses to start a store-enabled install without this. Loud
        // rather than a silent no-grant, because the customer has already been charged.
        throw new ServiceUnavailableError(
          'COMMERCE_STORE_PLAN_NAME is not set, so a verified store purchase has nothing to buy.',
        );
      }
      const plan = await planRepository.findPlanByName(planName);
      if (plan === null) {
        throw new ServiceUnavailableError(
          `No plan named "${planName}" has been loaded, so a verified ${row.store} purchase ` +
            'cannot be granted. Load the plan catalog before enabling store subscriptions.',
        );
      }
      const subscription = await planRepository.setSubscription({
        orgId: row.orgId,
        planId: plan.id,
        collector,
        note: `${row.store} subscription ${row.storeSubscriptionRef} (${row.environment}) reported ${row.status} by the store`,
        // No user. The store granted this, not a person clicking a button, and attributing it to
        // whoever happened to be signed in would be a false record of who decided.
        createdByUserId: null,
      });
      if (subscription === null) {
        throw new ServiceUnavailableError('The plan assignment produced no subscription.');
      }
      await storeSubscriptionRepository.setSubscriptionId(row.id, subscription.id);
      logger.info('commerce stores: organization subscribed from a store purchase', {
        orgId: row.orgId,
        store: row.store,
        planId: plan.id,
        subscriptionId: subscription.id,
      });
      return;
    }

    if (row.subscriptionId === null) return;
    // Only end the tenure this observation created. An org that also holds a Stripe-collected
    // subscription — a migration in progress, an operator override — must not lose it because a
    // store purchase lapsed.
    const active = await planRepository.activeSubscription(row.orgId);
    if (active !== null && active.id === row.subscriptionId) {
      await planRepository.setSubscription({
        orgId: row.orgId,
        planId: null,
        collector: null,
        note: `${row.store} subscription ${row.storeSubscriptionRef} reported ${row.status} by the store`,
        createdByUserId: null,
      });
      logger.warn('commerce stores: organization unsubscribed — the store subscription lapsed', {
        orgId: row.orgId,
        store: row.store,
        status: row.status,
      });
    }
    await storeSubscriptionRepository.setSubscriptionId(row.id, null);
  }
}

export const storeSubscriptionService = new StoreSubscriptionService();
