import { config } from '../../../config/unifiedConfig.js';
import { ServiceUnavailableError } from '../../../utils/errors.js';
import { appleStoreProvider } from './appleStore.js';
import { googlePlayProvider } from './googlePlay.js';
import type { StoreProvider } from './types.js';

/**
 * The store registry — and the one place it differs in shape from `payments/index.ts`.
 *
 * Payments selects by CONFIG: one install collects through one provider. Stores select by
 * ARGUMENT, because an app that ships on both platforms has both stores live at once, and the
 * question is never "which store does this install use" but "which store is this delivery from".
 * The caller always knows, because it came in on that store's own route.
 *
 * What is still config is whether each store is enabled at all. A disabled store refuses here
 * rather than deeper in the adapter, so a webhook arriving for a store this install was never
 * configured for is a 503 naming the flag instead of a confusing credential error.
 */

export const STORES = ['apple', 'google'] as const;

export type StoreName = (typeof STORES)[number];

function assertNever(store: never): never {
  throw new Error(`unhandled store: ${String(store)}`);
}

export function buildStoreProvider(store: StoreName): StoreProvider {
  switch (store) {
    case 'apple':
      if (!config.appleStore.enabled) {
        throw new ServiceUnavailableError(
          'The App Store integration is not configured (APPLE_STORE_ENABLED).',
        );
      }
      return appleStoreProvider;
    case 'google':
      if (!config.googlePlay.enabled) {
        throw new ServiceUnavailableError(
          'The Google Play integration is not configured (GOOGLE_PLAY_ENABLED).',
        );
      }
      return googlePlayProvider;
    default:
      return assertNever(store);
  }
}

/**
 * The one product id this install sells on that store. Read here rather than in each adapter
 * because "is this the thing we sell" is an application question, not a signature question: the
 * adapter's job ends at proving the store really said it.
 */
export function storeProductId(store: StoreName): string {
  switch (store) {
    case 'apple':
      if (!config.appleStore.enabled) {
        throw new ServiceUnavailableError('The App Store integration is not configured.');
      }
      return config.appleStore.productId;
    case 'google':
      if (!config.googlePlay.enabled) {
        throw new ServiceUnavailableError('The Google Play integration is not configured.');
      }
      return config.googlePlay.productId;
    default:
      return assertNever(store);
  }
}
