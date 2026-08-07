import { z } from 'zod';
import type { EmbeddedSignupConfig } from '@stewra/shared-types';

/**
 * Meta Embedded Signup — the browser half of connecting a client's OWN WhatsApp Business Account.
 *
 * Stewra never creates an account on any platform. This dialog runs on Meta's domain, under the
 * client's own Meta login, and asks them to grant this app access to a WABA they already own (or to
 * create one there, inside Meta's UI, if they have none). We never see their password.
 *
 * What comes back is a short-lived authorization CODE and nothing else. Everything that matters —
 * which WABA was granted, which numbers it has, whether they are registered — is re-read server-side
 * from Meta with the app secret, because a browser can claim anything. That is why this module
 * deliberately returns only the code, and why the ids Meta's dialog reports over `postMessage` are
 * used for error text alone and never sent to the API.
 *
 * The SDK is loaded on first use rather than in `index.html`: a third-party script on every page
 * load is a cost every visitor pays for a button most of them will never press. If a
 * Content-Security-Policy is ever added to this site, `connect.facebook.net` must be allowlisted in
 * `script-src` or this flow stops working.
 */

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

/** Meta's dialog posts its progress from this exact origin; messages from anywhere else are ignored. */
const SIGNUP_ORIGIN = 'https://www.facebook.com';

interface FacebookAuthResponse {
  readonly code?: string;
}

interface FacebookLoginResponse {
  readonly authResponse?: FacebookAuthResponse | null;
  readonly status?: string;
}

/**
 * Only the two calls this flow makes are declared. Meta's SDK is far larger; typing the rest would
 * be inventing a contract we do not exercise.
 */
interface FacebookSdk {
  init(options: { appId: string; version: string; xfbml: boolean; autoLogAppEvents: boolean }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: boolean;
      extras: { setup: Record<string, never>; featureType: string; sessionInfoVersion: string };
    },
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
  }
}

/**
 * Cached across calls because `FB.init` is once-per-page — a second init with the same app is
 * wasted work, and the deploy serves one `appId`. Cleared on failure so a client who lost their
 * network for a moment can simply press the button again.
 */
let sdkReady: Promise<FacebookSdk> | null = null;

function loadSdk(config: EmbeddedSignupConfig): Promise<FacebookSdk> {
  if (sdkReady !== null) {
    return sdkReady;
  }

  const pending = new Promise<FacebookSdk>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = (): void => {
      const fb = window.FB;
      if (fb === undefined) {
        reject(
          new Error(
            `Meta's JavaScript SDK loaded from ${SDK_URL} but did not install itself. A browser ` +
              'extension or content blocker is the usual cause.',
          ),
        );
        return;
      }
      fb.init({
        appId: config.appId,
        version: config.graphVersion,
        xfbml: false,
        autoLogAppEvents: true,
      });
      resolve(fb);
    };
    script.onerror = (): void => {
      reject(
        new Error(
          `Could not load Meta's JavaScript SDK from ${SDK_URL}. Check the network connection and ` +
            'any content blocker, then try again.',
        ),
      );
    };
    document.head.appendChild(script);
  });

  sdkReady = pending;
  void pending.catch(() => {
    if (sdkReady === pending) {
      sdkReady = null;
    }
  });
  return pending;
}

/**
 * Meta's `WA_EMBEDDED_SIGNUP` progress event, as much of it as this flow acts on.
 *
 * Validated rather than asserted: it arrives over `postMessage` from another origin, so its shape is
 * a claim by a remote party, not something the compiler can vouch for.
 */
const signupEventSchema = z.object({
  type: z.literal('WA_EMBEDDED_SIGNUP'),
  event: z.string(),
  data: z
    .object({
      error_message: z.string().optional(),
      current_step: z.string().optional(),
    })
    .optional(),
});

/**
 * Reads one `postMessage` payload from Meta's dialog into a failure description.
 *
 * Returns null when the message is not a signup failure — which is the honest answer, not a
 * swallowed error: `window` receives messages from the dev server, browser extensions and any
 * embedded frame, and none of those are failures in this flow.
 */
function readSignupFailure(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // Not JSON, so not one of Meta's reports. Nothing has failed — see the docblock above.
    return null;
  }
  const parsed = signupEventSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.event !== 'ERROR') {
    return null;
  }
  const { error_message: message, current_step: step } = parsed.data.data ?? {};
  if (message !== undefined && message.length > 0) {
    return message;
  }
  if (step !== undefined && step.length > 0) {
    return `Meta stopped the connection at the "${step}" step.`;
  }
  return 'Meta stopped the connection without saying why.';
}

/**
 * Opens Meta's Embedded Signup dialog and resolves with the one-time authorization code.
 *
 * Returns null when the client closed the dialog without finishing — that is a decision they made,
 * not a failure, and the caller should say so rather than show an error. Throws when the SDK cannot
 * load or Meta reports the flow failed, so a genuine breakage is never mistaken for a cancellation.
 */
export async function launchEmbeddedSignup(config: EmbeddedSignupConfig): Promise<string | null> {
  const fb = await loadSdk(config);

  let dialogFailure: string | null = null;
  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== SIGNUP_ORIGIN) {
      return;
    }
    const failure = readSignupFailure(event.data);
    if (failure !== null) {
      dialogFailure = failure;
    }
  };
  window.addEventListener('message', onMessage);

  try {
    const response = await new Promise<FacebookLoginResponse>((resolve) => {
      fb.login(resolve, {
        config_id: config.configId,
        // Embedded Signup hands back a code for the server to exchange, never an access token —
        // the exchange needs the app secret, which has no business in a browser.
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      });
    });

    const code = response.authResponse?.code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
    if (dialogFailure !== null) {
      throw new Error(dialogFailure);
    }
    return null;
  } finally {
    window.removeEventListener('message', onMessage);
  }
}
