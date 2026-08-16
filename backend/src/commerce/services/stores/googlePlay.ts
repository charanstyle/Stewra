import { createPublicKey } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../../../config/unifiedConfig.js';
import {
  AuthenticationError,
  ServiceUnavailableError,
  ValidationError,
} from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import type {
  StoreNotification,
  StoreProvider,
  StoreSubscriptionState,
  StoreSubscriptionStatus,
} from './types.js';

/**
 * Google Play, over plain `fetch` and `node:crypto` — same posture as the Apple adapter: no vendor
 * SDK, every response parsed with zod rather than asserted, and a misconfigured integration that
 * refuses rather than degrading.
 *
 * Google's shape is the inverse of Apple's in the one way that matters most:
 *
 * **The delivery is not signed.** A Real-time Developer Notification arrives as an ordinary
 * Pub/Sub push — plain JSON, no signature anywhere in the body, and a body that anybody who learns
 * the URL can POST. The entire proof lives in the `Authorization: Bearer` OIDC token, and
 * verifying it is a three-part question, all three of which are load-bearing: is it really signed
 * by Google, was it minted for THIS endpoint (`aud`), and was it minted by OUR push subscription
 * (`email`). Checking only the signature accepts a token from any Google Cloud account on earth,
 * which is to say: from anyone.
 *
 * **The notification tells you almost nothing.** It carries a purchase token and an event number,
 * and that is deliberate on Google's part — the state is whatever the Android Publisher API says
 * when you ask, and asking is mandatory. So the event number is never mapped to a status here.
 * Every subscription notification is followed by a `purchases.subscriptionsv2.get`, and that
 * response is the only thing written down.
 *
 * The one exception is a refund, which the v2 endpoint simply does not express — see the
 * `voidedPurchaseNotification` branch.
 */

function googleConfig(): {
  packageName: string;
  serviceAccountEmail: string;
  serviceAccountPrivateKey: string;
  pubsubAudience: string;
  pubsubServiceAccountEmail: string;
  environment: 'sandbox' | 'production';
  apiBaseUrl: string;
  tokenUrl: string;
  jwksUrl: string;
} {
  const cfg = config.googlePlay;
  if (!cfg.enabled) {
    throw new ServiceUnavailableError('The Google Play integration is not configured.');
  }
  return cfg;
}

// ── Who sent this ────────────────────────────────────────────────────────────────────────────────

/**
 * Google's OIDC signing keys, cached.
 *
 * Fetched rather than pinned, unlike Apple's root: Google publishes no long-lived anchor for these
 * and rotates the keys themselves on its own schedule, so there is nothing stable to commit. The
 * TTL is short and a `kid` that is not in the cache forces one refetch — that is key rotation
 * working, not a fallback. If the key is still absent afterwards the token is refused.
 */
const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { keys: Map<string, JsonWebKey>; fetchedAt: number } | null = null;

const jwkSchema = z.object({
  kid: z.string().min(1),
  kty: z.literal('RSA'),
  n: z.string().min(1),
  e: z.string().min(1),
});

async function fetchJwks(): Promise<Map<string, JsonWebKey>> {
  const cfg = googleConfig();
  const response = await fetch(cfg.jwksUrl, { method: 'GET' });
  if (!response.ok) {
    throw new ServiceUnavailableError(
      `Google's public keys could not be fetched: HTTP ${response.status}. ` +
        'Play notifications cannot be authenticated without them.',
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ServiceUnavailableError(
      `Google's public key document is not JSON: ${String(error)}`,
    );
  }
  const envelope = z.object({ keys: z.array(z.unknown()) }).safeParse(body);
  if (!envelope.success) {
    throw new ServiceUnavailableError("Google's public key document carries no keys array.");
  }
  const keys = new Map<string, JsonWebKey>();
  for (const entry of envelope.data.keys) {
    // Non-RSA entries are skipped rather than fatal: Google is free to publish keys for algorithms
    // its OIDC tokens do not use, and a token needing one of those will fail the kid lookup below
    // with a precise error instead of taking the whole integration down on an unrelated addition.
    const parsed = jwkSchema.safeParse(entry);
    if (!parsed.success) continue;
    keys.set(parsed.data.kid, { kty: 'RSA', n: parsed.data.n, e: parsed.data.e });
  }
  if (keys.size === 0) {
    throw new ServiceUnavailableError("Google's public key document contained no usable RSA keys.");
  }
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

async function googleSigningKey(kid: string): Promise<JsonWebKey> {
  const cached = jwksCache;
  if (cached !== null && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    const hit = cached.keys.get(kid);
    if (hit !== undefined) return hit;
  }
  const keys = await fetchJwks();
  const key = keys.get(kid);
  if (key === undefined) {
    throw new AuthenticationError(
      `That Pub/Sub delivery is signed with key ${kid}, which Google does not currently publish.`,
    );
  }
  return key;
}

/** Google issues ID tokens under both spellings; both are Google, neither is a guess. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const oidcClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  email: z.string().min(1),
  email_verified: z.boolean(),
});

/**
 * Prove the delivery is Google's, and ours.
 *
 * Every step is a refusal, and the last two are the ones that are easy to leave out:
 *  1. the header must name RS256 and a key id — `alg` is never taken from the token as a choice,
 *     only checked against the one algorithm Google signs these with;
 *  2. the signature must verify against Google's published key for that id;
 *  3. `aud` must be the audience configured on OUR push subscription — a token minted for someone
 *     else's endpoint is not authorization to write to this one;
 *  4. `email` must be OUR push service account, verified. Without this, any Google Cloud customer
 *     could point a push subscription at this URL and their tokens would verify perfectly.
 */
async function verifyPubsubToken(authorizationHeader: string | null): Promise<void> {
  const cfg = googleConfig();
  if (authorizationHeader === null || !authorizationHeader.startsWith('Bearer ')) {
    throw new AuthenticationError(
      'That Play delivery carries no bearer token. A Pub/Sub push is unsigned; the token is the ' +
        'only thing that distinguishes Google from anyone else who knows this URL.',
    );
  }
  const token = authorizationHeader.slice('Bearer '.length).trim();
  const decoded = jwt.decode(token, { complete: true });
  if (decoded === null || typeof decoded === 'string') {
    throw new AuthenticationError('That Play delivery\'s bearer token is not a JWT.');
  }
  const header = z
    .object({ alg: z.string().min(1), kid: z.string().min(1) })
    .safeParse(decoded.header);
  if (!header.success) {
    throw new AuthenticationError('That Play delivery\'s token has no usable RS256 key header.');
  }
  if (header.data.alg !== 'RS256') {
    throw new AuthenticationError(
      `Google's Pub/Sub tokens are signed RS256; this one claims ${header.data.alg}.`,
    );
  }

  const jwk = await googleSigningKey(header.data.kid);
  let payload: unknown;
  try {
    payload = jwt.verify(token, createPublicKey({ key: jwk, format: 'jwk' }), {
      algorithms: ['RS256'],
    });
  } catch (error) {
    throw new AuthenticationError(
      `That Play delivery's token does not verify: ${String(error)}`,
    );
  }
  const claims = oidcClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw new AuthenticationError(
      'That Play delivery\'s token verified but is missing the claims that say who it is for.',
    );
  }
  if (!GOOGLE_ISSUERS.includes(claims.data.iss)) {
    throw new AuthenticationError(
      `That Play delivery's token was issued by ${claims.data.iss}, not Google.`,
    );
  }
  if (claims.data.aud !== cfg.pubsubAudience) {
    throw new AuthenticationError(
      "That Play delivery's token was minted for a different audience than this endpoint.",
    );
  }
  if (!claims.data.email_verified || claims.data.email !== cfg.pubsubServiceAccountEmail) {
    throw new AuthenticationError(
      `That Play delivery's token belongs to ${claims.data.email}, not this install's push ` +
        'service account. Signed by Google is not the same as sent by us.',
    );
  }
}

// ── What it says ─────────────────────────────────────────────────────────────────────────────────

/**
 * The Pub/Sub push envelope. `messageId` is Pub/Sub's own id for the delivery and is the dedupe
 * key: Pub/Sub guarantees at-least-once, so the same message WILL arrive twice, identical in every
 * other respect.
 */
const pushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().min(1),
  }),
});

const developerNotificationSchema = z.object({
  packageName: z.string().min(1),
  subscriptionNotification: z
    .object({
      notificationType: z.number().int(),
      purchaseToken: z.string().min(1),
      subscriptionId: z.string().min(1),
    })
    .optional(),
  voidedPurchaseNotification: z
    .object({
      purchaseToken: z.string().min(1),
      orderId: z.string().min(1).optional(),
      /** 1 = subscription, 2 = one-time. Only the first concerns this adapter. */
      productType: z.number().int().optional(),
    })
    .optional(),
  testNotification: z.object({ version: z.string().min(1) }).optional(),
});

/**
 * Names for Play's numeric event types, for the audit trail only.
 *
 * Nothing branches on these. The status always comes from a fresh `subscriptionsv2.get`, exactly
 * as the Apple adapter derives status from transaction data rather than notification names — an
 * unrecognized number here costs a readable label and nothing else.
 */
const SUBSCRIPTION_NOTIFICATION_NAMES = new Map<number, string>([
  [1, 'SUBSCRIPTION_RECOVERED'],
  [2, 'SUBSCRIPTION_RENEWED'],
  [3, 'SUBSCRIPTION_CANCELED'],
  [4, 'SUBSCRIPTION_PURCHASED'],
  [5, 'SUBSCRIPTION_ON_HOLD'],
  [6, 'SUBSCRIPTION_IN_GRACE_PERIOD'],
  [7, 'SUBSCRIPTION_RESTARTED'],
  [8, 'SUBSCRIPTION_PRICE_CHANGE_CONFIRMED'],
  [9, 'SUBSCRIPTION_DEFERRED'],
  [10, 'SUBSCRIPTION_PAUSED'],
  [11, 'SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED'],
  [12, 'SUBSCRIPTION_REVOKED'],
  [13, 'SUBSCRIPTION_EXPIRED'],
  [20, 'SUBSCRIPTION_PENDING_PURCHASE_CANCELED'],
]);

function notificationTypeName(type: number): string {
  return SUBSCRIPTION_NOTIFICATION_NAMES.get(type) ?? `SUBSCRIPTION_UNRECOGNIZED_${type}`;
}

/** Play's own revocation event. Handled beside the voided-purchase feed, which can lag it. */
const SUBSCRIPTION_REVOKED = 12;

// ── What Google says about it ────────────────────────────────────────────────────────────────────

const lineItemSchema = z.object({
  productId: z.string().min(1),
  /** RFC 3339. Absent on a plan that has no expiry yet — a pending purchase, chiefly. */
  expiryTime: z.string().min(1).optional(),
  autoRenewingPlan: z.object({ autoRenewEnabled: z.boolean().optional() }).optional(),
});

const subscriptionPurchaseSchema = z.object({
  subscriptionState: z.string().min(1),
  latestOrderId: z.string().min(1).optional(),
  /**
   * The token this purchase REPLACES. Play mints a new one on every upgrade, downgrade and
   * resubscribe; this is the thread back to the row that must now be retired.
   */
  linkedPurchaseToken: z.string().min(1).optional(),
  /** Present, and empty, when the buyer is a license tester. Absence is the only "real" signal. */
  testPurchase: z.object({}).optional(),
  lineItems: z.array(lineItemSchema).min(1),
});

type SubscriptionPurchase = z.infer<typeof subscriptionPurchaseSchema>;

/**
 * Derive the status from Play's own state machine.
 *
 * This switches on `subscriptionState`, which is not the thing the Apple adapter refuses to switch
 * on. That refusal is about EVENT NAMES — a growing list of things that happened. This is the
 * store's current answer to "what is this subscription", a closed enum Google versions
 * deliberately, and it is the field that exists to be read.
 *
 * `SUBSCRIPTION_STATE_CANCELED` is the trap. It does not mean access has stopped: it means
 * auto-renew is off and the customer keeps what they paid for until the period ends. Cutting them
 * off on the cancel event takes away time they bought.
 *
 * An unrecognized state throws. Pub/Sub will retry and eventually give up, and that is the correct
 * outcome — a state nobody has read the meaning of cannot be turned into an entitlement decision by
 * picking whichever branch looks close.
 */
function deriveStatus(
  state: string,
  expiryMillis: number | null,
  now: number,
): StoreSubscriptionStatus {
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return 'active';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'grace_period';
    case 'SUBSCRIPTION_STATE_PENDING':
      return 'pending';
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return 'on_hold';
    case 'SUBSCRIPTION_STATE_PAUSED':
      return 'paused';
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return 'expired';
    case 'SUBSCRIPTION_STATE_CANCELED':
      return expiryMillis !== null && expiryMillis > now ? 'active' : 'expired';
    default:
      throw new Error(
        `Google Play reported subscription state ${state}, which this adapter does not know how ` +
          'to turn into an entitlement. Refusing to guess.',
      );
  }
}

function expiryOf(purchase: SubscriptionPurchase): number | null {
  const times: number[] = [];
  for (const item of purchase.lineItems) {
    if (item.expiryTime === undefined) continue;
    const parsed = Date.parse(item.expiryTime);
    if (Number.isNaN(parsed)) {
      throw new Error(`Google Play returned an unparseable expiryTime: ${item.expiryTime}`);
    }
    times.push(parsed);
  }
  // The latest across line items: entitlement lasts as long as the longest-lived item on the plan.
  return times.length === 0 ? null : Math.max(...times);
}

function toState(
  purchaseToken: string,
  purchase: SubscriptionPurchase,
  now: number,
): StoreSubscriptionState {
  const first = purchase.lineItems[0];
  if (first === undefined) {
    throw new Error('Google Play returned a subscription with no line items.');
  }
  const expiryMillis = expiryOf(purchase);
  return {
    store: 'google',
    // A license tester's purchase is free and comes back from the same endpoint as a paid one.
    // This marker is the only thing separating them, so it is read off the purchase itself rather
    // than assumed from config, and compared against config in `assertOurs`.
    environment: purchase.testPurchase === undefined ? 'production' : 'sandbox',
    productId: first.productId,
    storeSubscriptionRef: purchaseToken,
    latestTransactionRef: purchase.latestOrderId ?? null,
    status: deriveStatus(purchase.subscriptionState, expiryMillis, now),
    currentPeriodEnd: expiryMillis === null ? null : new Date(expiryMillis),
    autoRenewing: purchase.lineItems.some(
      (item) => item.autoRenewingPlan?.autoRenewEnabled === true,
    ),
    supersedesRef: purchase.linkedPurchaseToken ?? null,
  };
}

/** A test purchase must never grant a production entitlement, and the reverse is just as wrong. */
function assertOurEnvironment(environment: 'sandbox' | 'production'): void {
  const cfg = googleConfig();
  if (environment !== cfg.environment) {
    throw new AuthenticationError(
      `That Play purchase is a ${environment} purchase; this install is ${cfg.environment}. ` +
        'A license tester must never hold a real entitlement.',
    );
  }
}

// ── Talking to the Android Publisher API ─────────────────────────────────────────────────────────

const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
/** Renew a minute early rather than discover expiry mid-request. */
const TOKEN_SKEW_MS = 60 * 1000;

let accessTokenCache: { value: string; expiresAt: number } | null = null;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

/**
 * A service-account access token, via the JWT bearer grant.
 *
 * No user, no refresh token, no interactive consent: a JWT signed with the service account's key,
 * exchanged for a short-lived token. Cached until just before it expires.
 */
async function accessToken(): Promise<string> {
  const cached = accessTokenCache;
  if (cached !== null && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.value;

  const cfg = googleConfig();
  const assertion = jwt.sign(
    { scope: ANDROID_PUBLISHER_SCOPE },
    cfg.serviceAccountPrivateKey,
    {
      algorithm: 'RS256',
      issuer: cfg.serviceAccountEmail,
      subject: cfg.serviceAccountEmail,
      audience: cfg.tokenUrl,
      expiresIn: '1h',
    },
  );

  const response = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ServiceUnavailableError(
      `Google refused the service-account token exchange: HTTP ${response.status} ${text}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new ServiceUnavailableError(
      `Google returned a token response that is not JSON: ${String(error)}`,
    );
  }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ServiceUnavailableError(
      'Google returned a token response that did not match the expected shape.',
    );
  }
  accessTokenCache = {
    value: parsed.data.access_token,
    expiresAt: Date.now() + parsed.data.expires_in * 1000,
  };
  return parsed.data.access_token;
}

class GooglePlayProvider implements StoreProvider {
  readonly store = 'google' as const;

  async verifyNotification(
    rawBody: Buffer,
    authorizationHeader: string | null,
  ): Promise<StoreNotification> {
    // FIRST. Nothing in the body is looked at, let alone parsed, until we know who sent it.
    await verifyPubsubToken(authorizationHeader);

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AuthenticationError('That Play delivery is not JSON.');
    }
    const envelope = pushEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      throw new AuthenticationError('That Play delivery is not a Pub/Sub push envelope.');
    }
    const notificationRef = envelope.data.message.messageId;

    let inner: unknown;
    try {
      inner = JSON.parse(Buffer.from(envelope.data.message.data, 'base64').toString('utf8'));
    } catch {
      throw new AuthenticationError('That Play delivery carries no decodable notification.');
    }
    const notification = developerNotificationSchema.safeParse(inner);
    if (!notification.success) {
      throw new AuthenticationError(
        'That Play delivery verified but is not a developer notification.',
      );
    }

    const cfg = googleConfig();
    if (notification.data.packageName !== cfg.packageName) {
      throw new AuthenticationError(
        `That Play notification is for package ${notification.data.packageName}, not ${cfg.packageName}.`,
      );
    }

    // The Play Console's "Send test notification" button, and nothing else. ACK it.
    if (notification.data.testNotification !== undefined) {
      return {
        kind: 'ignored',
        notificationRef,
        notificationType: 'TEST',
        subtype: null,
        reason: 'a Play Console test notification',
      };
    }

    const voided = notification.data.voidedPurchaseNotification;
    if (voided !== undefined) {
      // productType 2 is a one-time product; this install sells none, and acting on one would mean
      // revoking a subscription that shares nothing with it but a customer.
      if (voided.productType !== undefined && voided.productType !== 1) {
        return {
          kind: 'ignored',
          notificationRef,
          notificationType: 'VOIDED_PURCHASE',
          subtype: null,
          reason: `a voided one-time purchase (productType ${voided.productType})`,
        };
      }
      // No lookup. `subscriptionsv2.get` has no way to say "refunded" — it reports a voided
      // subscription as merely expired — and on a fully revoked token it may not answer at all.
      // The notification is the evidence, so it is acted on directly.
      return {
        kind: 'revoked',
        notificationRef,
        notificationType: 'VOIDED_PURCHASE',
        subtype: null,
        store: 'google',
        storeSubscriptionRef: voided.purchaseToken,
      };
    }

    const subscription = notification.data.subscriptionNotification;
    if (subscription === undefined) {
      return {
        kind: 'ignored',
        notificationRef,
        notificationType: 'UNKNOWN',
        subtype: null,
        reason: 'the notification concerns neither a subscription nor a voided purchase',
      };
    }

    const notificationType = notificationTypeName(subscription.notificationType);
    if (subscription.notificationType === SUBSCRIPTION_REVOKED) {
      // Same reasoning as the voided feed: Play's own revocation event, which the state read would
      // flatten into "expired". Whichever of the two arrives first is the one that acts.
      return {
        kind: 'revoked',
        notificationRef,
        notificationType,
        subtype: null,
        store: 'google',
        storeSubscriptionRef: subscription.purchaseToken,
      };
    }

    // Everything else: the event says only WHICH purchase changed. Google is the one who says how.
    const state = await this.readSubscription(subscription.purchaseToken);
    return {
      kind: 'subscription',
      notificationRef,
      notificationType,
      // Play has no subtype; Apple's is carried through the same field and this one stays honest.
      subtype: null,
      state,
    };
  }

  async readSubscription(storeSubscriptionRef: string): Promise<StoreSubscriptionState> {
    const cfg = googleConfig();
    const token = await accessToken();
    const url =
      `${cfg.apiBaseUrl}/androidpublisher/v3/applications/${encodeURIComponent(cfg.packageName)}` +
      `/purchases/subscriptionsv2/tokens/${encodeURIComponent(storeSubscriptionRef)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    if (!response.ok) {
      // 404 and 410 are both the ordinary "we do not know that token": a claim for a purchase that
      // does not exist, or one Play has finished with. A validation failure so the caller's request
      // is refused, rather than retried forever as though Google were down.
      if (response.status === 404 || response.status === 410) {
        throw new ValidationError('Validation failed', [
          {
            field: 'storeSubscriptionRef',
            message: 'Google Play does not know that purchase token.',
          },
        ]);
      }
      throw new Error(`Google refused the subscription lookup: HTTP ${response.status} ${text}`);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('Google returned a subscription lookup that is not JSON.');
    }
    const parsed = subscriptionPurchaseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        'Google returned a subscription lookup that did not match the expected shape: ' +
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }

    const state = toState(storeSubscriptionRef, parsed.data, Date.now());
    assertOurEnvironment(state.environment);

    logger.info('commerce stores: read a Google Play subscription', {
      status: state.status,
      environment: state.environment,
      supersedes: state.supersedesRef !== null,
    });
    return state;
  }
}

export const googlePlayProvider = new GooglePlayProvider();

/** Exported for the suite that drives the token check against a generated key and a scripted Play. */
export const googlePlayInternals = { verifyPubsubToken, deriveStatus, toState, notificationTypeName };
