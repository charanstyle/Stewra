/**
 * Stripe Elements — the browser half of putting a card on file.
 *
 * The card number is typed into an iframe served by Stripe and never touches this page's DOM, this
 * bundle, or Stewra's servers. What this module does is: load Stripe's script, mount their card
 * field, confirm the SetupIntent whose client secret the API handed us, and report back the id of
 * the setup. That id is all the server is told — it goes and asks Stripe what was actually
 * attached, because a browser can claim anything. Exactly the reasoning in `metaEmbeddedSignup.ts`,
 * applied to money.
 *
 * No `@stripe/stripe-js` dependency: it is a script loader, this is a script loader, and the
 * backend's own Stripe adapter already made the same call the other way ("the four calls billing
 * needs do not justify a dependency that can move under us").
 *
 * The script is loaded on first use rather than in `index.html`, so visitors who never open
 * billing never pay for it. If a Content-Security-Policy is ever added to this site,
 * `js.stripe.com` must be allowlisted in `script-src` and `frame-src` or card entry stops working.
 */

const SDK_URL = 'https://js.stripe.com/v3/';

/** The subset of Stripe's element styling this page sets. Declared, not a weak record. */
interface StripeElementStyle {
  readonly base?: {
    readonly color?: string;
    readonly fontFamily?: string;
    readonly fontSize?: string;
    readonly '::placeholder'?: { readonly color?: string };
  };
  readonly invalid?: { readonly color?: string };
}

interface StripeCardElementOptions {
  readonly style?: StripeElementStyle;
  readonly hidePostalCode?: boolean;
}

/** Only what this flow uses. Stripe's surface is enormous; typing the rest would be fiction. */
interface StripeCardElement {
  mount(target: string | HTMLElement): void;
  unmount(): void;
  destroy(): void;
  on(event: 'change', handler: (event: { error?: { message?: string } }) => void): void;
}

interface StripeElements {
  create(type: 'card', options?: StripeCardElementOptions): StripeCardElement;
}

interface StripeSetupIntentResult {
  readonly setupIntent?: { readonly id: string; readonly status: string };
  readonly error?: { readonly message?: string };
}

interface StripeSdk {
  elements(): StripeElements;
  confirmCardSetup(
    clientSecret: string,
    data: { payment_method: { card: StripeCardElement } },
  ): Promise<StripeSetupIntentResult>;
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeSdk;
  }
}

/**
 * Cached per publishable key. Re-running `Stripe(key)` is harmless but pointless, and a deploy
 * serves exactly one key. Cleared on failure so a client who blinked out of network can retry.
 */
let sdkReady: Promise<StripeSdk> | null = null;
let sdkKey: string | null = null;

export function loadStripe(publishableKey: string): Promise<StripeSdk> {
  if (sdkReady !== null && sdkKey === publishableKey) return sdkReady;

  const pending = new Promise<StripeSdk>((resolve, reject) => {
    const existing = window.Stripe;
    if (existing !== undefined) {
      resolve(existing(publishableKey));
      return;
    }
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = (): void => {
      const stripe = window.Stripe;
      if (stripe === undefined) {
        reject(
          new Error(
            `Stripe's script loaded from ${SDK_URL} but did not install itself. A browser ` +
              'extension or content blocker is the usual cause.',
          ),
        );
        return;
      }
      resolve(stripe(publishableKey));
    };
    script.onerror = (): void => {
      reject(
        new Error(
          `Could not load Stripe from ${SDK_URL}. Check the network connection and any content ` +
            'blocker, then try again.',
        ),
      );
    };
    document.head.appendChild(script);
  });

  sdkReady = pending.catch((error: unknown) => {
    // Do not cache a failure: the next press should retry the load, not replay the error forever.
    sdkReady = null;
    sdkKey = null;
    throw error;
  });
  sdkKey = publishableKey;
  return sdkReady;
}

/**
 * Confirm the setup the API opened, and return ITS id — never the payment method's.
 *
 * The `succeeded` check here authorizes nothing; the server re-reads the setup from Stripe before
 * storing anything. It exists so the page can tell the customer their card was declined without a
 * round trip that would say the same thing in a worse voice.
 */
export async function confirmCardSetup(params: {
  stripe: StripeSdk;
  card: StripeCardElement;
  clientSecret: string;
}): Promise<string> {
  const result = await params.stripe.confirmCardSetup(params.clientSecret, {
    payment_method: { card: params.card },
  });
  if (result.error !== undefined) {
    throw new Error(result.error.message ?? 'Stripe could not save that card.');
  }
  // Two genuinely different failures, said differently. Stripe answering with neither an error nor
  // a setup means the contract broke; a setup that exists but did not succeed means the card did.
  const intent = result.setupIntent;
  if (intent === undefined) {
    throw new Error(
      'Stripe returned neither an error nor a card setup. Nothing has been saved; try again.',
    );
  }
  if (intent.status !== 'succeeded') {
    throw new Error(`That card setup finished as "${intent.status}" rather than succeeded.`);
  }
  return intent.id;
}

export type { StripeCardElement, StripeSdk };
