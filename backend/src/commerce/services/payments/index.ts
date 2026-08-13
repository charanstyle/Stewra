import { config } from '../../../config/unifiedConfig.js';
import { manualProvider } from './manualProvider.js';
import { stripeProvider } from './stripeProvider.js';
import type { PaymentProvider } from './types.js';

/**
 * The registry, same shape as `senders/index.ts`: a switch over the closed union, with
 * `assertNever` making a new provider a compile error until someone decides how it pays.
 * Selection is by CONFIG, not by argument — one install collects through one provider, chosen at
 * boot, and the boot guard has already refused a half-configured choice.
 */

function assertNever(provider: never): never {
  throw new Error(`unhandled payment provider: ${String(provider)}`);
}

export function buildPaymentProvider(): PaymentProvider {
  const cfg = config.commerceBilling;
  switch (cfg.provider) {
    case 'manual':
      return manualProvider;
    case 'stripe':
      return stripeProvider;
    default:
      return assertNever(cfg);
  }
}
