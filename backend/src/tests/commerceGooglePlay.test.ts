import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

/**
 * THE BEARER TOKEN — the only thing standing between "Google said so" and anyone who learns the URL.
 *
 * A Play Real-time Developer Notification is an unsigned Pub/Sub push: plain JSON, no signature in
 * the body, delivered to a public endpoint. Everything that makes it trustworthy is in one HTTP
 * header, and checking that header is a THREE-part question, not one:
 *
 *   1. is it really signed by Google — otherwise anyone mints their own;
 *   2. is `aud` this endpoint — otherwise a token leaked from another service is a valid write here;
 *   3. is `email` OUR push service account — otherwise every Google Cloud customer on earth can
 *      point a push subscription at this URL and their tokens will verify perfectly.
 *
 * (3) is the one that is easy to leave out and impossible to notice missing, so it is tested here
 * against a token that is genuinely, correctly signed by the same key Google publishes.
 *
 * So this suite generates a real RSA key, serves a real JWKS from a real HTTP server, and signs
 * real RS256 tokens — rather than asserting a mock was called. It also scripts the Android
 * Publisher API, so the notification → token exchange → lookup chain runs end to end.
 */

/** Google's key, and the forger's — same size, same algorithm, different key. */
const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'google-key-1';

/** The Play service account whose key signs the Android Publisher token exchange. */
const serviceAccount = generateKeyPairSync('rsa', { modulusLength: 2048 });

const PACKAGE_NAME = 'com.stewra.app';
const PRODUCT_ID = 'com.stewra.standard.monthly';
const AUDIENCE = 'https://www.stewra.com/webhooks/stores/google';
const PUSH_SERVICE_ACCOUNT = 'stewra-play-push@stewra.iam.gserviceaccount.com';

function jwks(): { keys: unknown[] } {
  const jwk = google.publicKey.export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] };
}

/** What the scripted Android Publisher returns for the next lookup. */
let purchase: unknown = null;
let purchaseStatus = 200;
/** Every path the stand-in served — how "no lookup happened" is proved, not assumed. */
const playCalls: string[] = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const play: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // Drained rather than read: nothing here scripts on the request body, but an undrained request
  // never fires 'end' and the whole suite hangs on the first POST.
  req.on('data', () => {});
  req.on('end', () => {
    const path = req.url ?? '/';
    playCalls.push(path);
    if (path === '/jwks') {
      json(res, 200, jwks());
      return;
    }
    if (path === '/token') {
      json(res, 200, { access_token: `ya29.${randomUUID()}`, expires_in: 3599 });
      return;
    }
    if (path.includes('/purchases/subscriptionsv2/tokens/')) {
      json(res, purchaseStatus, purchase ?? { error: { message: 'not found' } });
      return;
    }
    json(res, 404, { error: { message: `unscripted play path: ${path}` } });
  });
});

await new Promise<void>((resolve) => play.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(play.address() as AddressInfo).port}`;

process.env['GOOGLE_PLAY_ENABLED'] = 'true';
process.env['GOOGLE_PLAY_PACKAGE_NAME'] = PACKAGE_NAME;
process.env['GOOGLE_PLAY_PRODUCT_ID'] = PRODUCT_ID;
// Required at boot alongside the credentials: a store that can verify a purchase but has nothing
// to grant for it would take the customer's money and hand back an observation.
process.env['COMMERCE_STORE_PLAN_NAME'] = 'Standard';
process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL'] = 'stewra-play@stewra.iam.gserviceaccount.com';
process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY'] = serviceAccount.privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;
process.env['GOOGLE_PLAY_PUBSUB_AUDIENCE'] = AUDIENCE;
process.env['GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL'] = PUSH_SERVICE_ACCOUNT;
// PRODUCTION on purpose: it is what makes the license-tester test below mean something.
process.env['GOOGLE_PLAY_ENVIRONMENT'] = 'production';
process.env['GOOGLE_PLAY_API_BASE_URL'] = origin;
process.env['GOOGLE_PLAY_TOKEN_URL'] = `${origin}/token`;
process.env['GOOGLE_PLAY_JWKS_URL'] = `${origin}/jwks`;

const { googlePlayProvider, googlePlayInternals } = await import(
  '../commerce/services/stores/googlePlay.js'
);
const { verifyPubsubToken, deriveStatus, toState } = googlePlayInternals;

afterAll(() => {
  play.close();
});

beforeEach(() => {
  playCalls.length = 0;
  purchaseStatus = 200;
});

// ── The bearer token ─────────────────────────────────────────────────────────────────────────────

interface TokenOverrides {
  aud?: string;
  email?: string;
  email_verified?: boolean;
  iss?: string;
  /** Seconds. Negative mints an already-expired token. */
  expiresIn?: number;
}

function oidcToken(overrides: TokenOverrides = {}, key = google.privateKey, kid = KID): string {
  return jwt.sign(
    {
      iss: overrides.iss ?? 'https://accounts.google.com',
      aud: overrides.aud ?? AUDIENCE,
      email: overrides.email ?? PUSH_SERVICE_ACCOUNT,
      email_verified: overrides.email_verified ?? true,
    },
    key,
    { algorithm: 'RS256', keyid: kid, expiresIn: overrides.expiresIn ?? 600 },
  );
}

describe('authenticating a Pub/Sub push', () => {
  it('accepts a token signed by the key Google publishes, for this endpoint, from our account', async () => {
    await expect(verifyPubsubToken(`Bearer ${oidcToken()}`)).resolves.toBeUndefined();
  });

  it('REFUSES a token from a different key presented under Google\'s key id', async () => {
    // The forger claims Google's `kid`, so the right public key is looked up — and the signature
    // made with a key Google never published does not verify against it.
    const token = oidcToken({}, forger.privateKey);
    await expect(verifyPubsubToken(`Bearer ${token}`)).rejects.toThrow(/does not verify/);
  });

  it('REFUSES a genuinely Google-signed token belonging to somebody else\'s service account', async () => {
    // The whole attack in one line: this token is real. Google minted it, Google signed it, it
    // verifies against Google's published key. It is refused because it is not OURS — without this
    // check, anyone with a Google Cloud project can push entitlement changes into this install.
    const token = oidcToken({ email: 'someone-else@their-project.iam.gserviceaccount.com' });
    await expect(verifyPubsubToken(`Bearer ${token}`)).rejects.toThrow(/not this install's push/);
  });

  it('refuses a token minted for a different audience', async () => {
    const token = oidcToken({ aud: 'https://someone-elses-service.example.com/hook' });
    await expect(verifyPubsubToken(`Bearer ${token}`)).rejects.toThrow(/different audience/);
  });

  it('refuses our own service account when the email is not verified', async () => {
    const token = oidcToken({ email_verified: false });
    await expect(verifyPubsubToken(`Bearer ${token}`)).rejects.toThrow(/not this install's push/);
  });

  it('refuses a token issued by something that is not Google', async () => {
    const token = oidcToken({ iss: 'https://accounts.google.com.evil.example' });
    await expect(verifyPubsubToken(`Bearer ${token}`)).rejects.toThrow(/not Google/);
  });

  it('refuses a symmetric algorithm, however good the claims look', async () => {
    // The classic confusion: a verifier that trusts `alg` would check an HMAC against a public key
    // it fetched from Google — and the "secret" is that public key, which is public.
    const token = jwt.sign({ aud: AUDIENCE, email: PUSH_SERVICE_ACCOUNT }, 'a-shared-secret', {
      algorithm: 'HS256',
      keyid: KID,
    });
    await expect(verifyPubsubToken(`Bearer ${token}`)).rejects.toThrow(/RS256/);
  });

  it('refuses an expired token', async () => {
    const token = oidcToken({ expiresIn: -60 });
    await expect(verifyPubsubToken(`Bearer ${token}`)).rejects.toThrow(/does not verify/);
  });

  it('refuses a key id Google does not publish', async () => {
    const token = oidcToken({}, google.privateKey, 'a-key-google-never-had');
    await expect(verifyPubsubToken(`Bearer ${token}`)).rejects.toThrow(/does not currently publish/);
  });

  it('refuses a delivery with no bearer token at all', async () => {
    await expect(verifyPubsubToken(null)).rejects.toThrow(/carries no bearer token/);
    await expect(verifyPubsubToken('Basic aGk6dGhlcmU=')).rejects.toThrow(/carries no bearer token/);
  });
});

// ── Reading a status out of Play's state machine ─────────────────────────────────────────────────

describe('reading a status out of the state', () => {
  const NOW = Date.UTC(2026, 7, 15);
  const LATER = NOW + 86_400_000;
  const EARLIER = NOW - 86_400_000;

  it('maps Play\'s states one for one', () => {
    expect(deriveStatus('SUBSCRIPTION_STATE_ACTIVE', LATER, NOW)).toBe('active');
    expect(deriveStatus('SUBSCRIPTION_STATE_IN_GRACE_PERIOD', EARLIER, NOW)).toBe('grace_period');
    expect(deriveStatus('SUBSCRIPTION_STATE_PENDING', null, NOW)).toBe('pending');
    expect(deriveStatus('SUBSCRIPTION_STATE_ON_HOLD', EARLIER, NOW)).toBe('on_hold');
    expect(deriveStatus('SUBSCRIPTION_STATE_PAUSED', LATER, NOW)).toBe('paused');
    expect(deriveStatus('SUBSCRIPTION_STATE_EXPIRED', EARLIER, NOW)).toBe('expired');
  });

  it('keeps a CANCELED subscription entitled until the period it paid for ends', () => {
    // Play's CANCELED means auto-renew is off, NOT that access stopped. Cutting the customer off
    // when the cancel event arrives takes away time they have already paid for.
    expect(deriveStatus('SUBSCRIPTION_STATE_CANCELED', LATER, NOW)).toBe('active');
    expect(deriveStatus('SUBSCRIPTION_STATE_CANCELED', EARLIER, NOW)).toBe('expired');
  });

  it('refuses to guess at a state it does not know', () => {
    expect(() => deriveStatus('SUBSCRIPTION_STATE_UNSPECIFIED', LATER, NOW)).toThrow(
      /does not know how/,
    );
    expect(() => deriveStatus('SUBSCRIPTION_STATE_SOMETHING_NEW', LATER, NOW)).toThrow(
      /Refusing to guess/,
    );
  });

  it('takes the LATEST expiry across line items as the end of entitlement', () => {
    const state = toState(
      'token-1',
      {
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        lineItems: [
          { productId: PRODUCT_ID, expiryTime: new Date(NOW + 1000).toISOString() },
          { productId: 'com.stewra.addon', expiryTime: new Date(LATER).toISOString() },
        ],
      },
      NOW,
    );
    expect(state.currentPeriodEnd?.getTime()).toBe(LATER);
  });

  it('carries the license-tester marker through as sandbox', () => {
    const state = toState(
      'token-1',
      {
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        testPurchase: {},
        lineItems: [{ productId: PRODUCT_ID, expiryTime: new Date(LATER).toISOString() }],
      },
      NOW,
    );
    expect(state.environment).toBe('sandbox');
  });

  it('reports the token it replaces, so the old row can be retired rather than duplicated', () => {
    const state = toState(
      'token-new',
      {
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        linkedPurchaseToken: 'token-old',
        lineItems: [{ productId: PRODUCT_ID, expiryTime: new Date(LATER).toISOString() }],
      },
      NOW,
    );
    expect(state.storeSubscriptionRef).toBe('token-new');
    expect(state.supersedesRef).toBe('token-old');
  });

  it('refuses an unparseable expiry rather than treating it as no expiry', () => {
    expect(() =>
      toState(
        'token-1',
        {
          subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
          lineItems: [{ productId: PRODUCT_ID, expiryTime: 'next tuesday' }],
        },
        NOW,
      ),
    ).toThrow(/unparseable expiryTime/);
  });
});

// ── The whole chain ──────────────────────────────────────────────────────────────────────────────

function push(notification: unknown, messageId = randomUUID()): Buffer {
  return Buffer.from(
    JSON.stringify({
      message: {
        data: Buffer.from(JSON.stringify(notification)).toString('base64'),
        messageId,
      },
      subscription: 'projects/stewra/subscriptions/play-rtdn',
    }),
  );
}

const ACTIVE_PURCHASE = {
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  latestOrderId: 'GPA.1234-5678-9012-34567',
  lineItems: [
    {
      productId: PRODUCT_ID,
      expiryTime: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      autoRenewingPlan: { autoRenewEnabled: true },
    },
  ],
};

describe('a notification, end to end', () => {
  it('ignores the event number and asks Google what the state actually is', async () => {
    // The push says CANCELED (3). Google says ACTIVE. The state written is Google's.
    purchase = ACTIVE_PURCHASE;
    const result = await googlePlayProvider.verifyNotification(
      push({
        packageName: PACKAGE_NAME,
        subscriptionNotification: {
          notificationType: 3,
          purchaseToken: 'token-abc',
          subscriptionId: PRODUCT_ID,
        },
      }),
      `Bearer ${oidcToken()}`,
    );
    expect(result.kind).toBe('subscription');
    if (result.kind !== 'subscription') throw new Error('unreachable');
    expect(result.notificationType).toBe('SUBSCRIPTION_CANCELED');
    expect(result.state.status).toBe('active');
    expect(result.state.storeSubscriptionRef).toBe('token-abc');
    expect(result.state.latestTransactionRef).toBe('GPA.1234-5678-9012-34567');
    expect(playCalls.some((p) => p.includes('/purchases/subscriptionsv2/tokens/token-abc'))).toBe(
      true,
    );
  });

  it('parses the body only AFTER the token is checked', async () => {
    // Garbage body, bad token: the complaint must be about the token. A verifier that parses first
    // is a verifier doing work on behalf of an unauthenticated caller.
    await expect(
      googlePlayProvider.verifyNotification(Buffer.from('not json at all'), 'Bearer nonsense'),
    ).rejects.toThrow(/not a JWT/);
    expect(playCalls).toEqual([]);
  });

  it('refuses a notification for a different app', async () => {
    await expect(
      googlePlayProvider.verifyNotification(
        push({
          packageName: 'com.someone.else',
          subscriptionNotification: {
            notificationType: 2,
            purchaseToken: 'token-abc',
            subscriptionId: PRODUCT_ID,
          },
        }),
        `Bearer ${oidcToken()}`,
      ),
    ).rejects.toThrow(/not com.stewra.app/);
  });

  it('acts on a refund WITHOUT a lookup, because the lookup cannot express one', async () => {
    // `subscriptionsv2.get` has no revoked state: a refunded subscription reads back as expired,
    // indistinguishable from one that ran its course. So the notification is the evidence — and it
    // still works when the token is dead enough that a lookup would 404.
    const result = await googlePlayProvider.verifyNotification(
      push({
        packageName: PACKAGE_NAME,
        voidedPurchaseNotification: { purchaseToken: 'token-abc', orderId: 'GPA.1', productType: 1 },
      }),
      `Bearer ${oidcToken()}`,
    );
    expect(result).toMatchObject({
      kind: 'revoked',
      store: 'google',
      storeSubscriptionRef: 'token-abc',
    });
    expect(playCalls.some((p) => p.includes('subscriptionsv2'))).toBe(false);
  });

  it('treats Play\'s own REVOKED event the same way', async () => {
    const result = await googlePlayProvider.verifyNotification(
      push({
        packageName: PACKAGE_NAME,
        subscriptionNotification: {
          notificationType: 12,
          purchaseToken: 'token-abc',
          subscriptionId: PRODUCT_ID,
        },
      }),
      `Bearer ${oidcToken()}`,
    );
    expect(result.kind).toBe('revoked');
    expect(playCalls.some((p) => p.includes('subscriptionsv2'))).toBe(false);
  });

  it('leaves a voided ONE-TIME purchase alone', async () => {
    const result = await googlePlayProvider.verifyNotification(
      push({
        packageName: PACKAGE_NAME,
        voidedPurchaseNotification: { purchaseToken: 'token-abc', productType: 2 },
      }),
      `Bearer ${oidcToken()}`,
    );
    expect(result.kind).toBe('ignored');
  });

  it('ACKs a Play Console test notification without touching anything', async () => {
    const result = await googlePlayProvider.verifyNotification(
      push({ packageName: PACKAGE_NAME, testNotification: { version: '1.0' } }),
      `Bearer ${oidcToken()}`,
    );
    expect(result).toMatchObject({ kind: 'ignored', notificationType: 'TEST' });
    expect(playCalls.some((p) => p.includes('subscriptionsv2'))).toBe(false);
  });

  it('REFUSES a license tester\'s free purchase on a production install', async () => {
    // This install is configured `production`. Play returns test purchases from the same endpoint
    // as paid ones, so without this comparison anyone on the tester list holds a real, free $149
    // entitlement for as long as they like.
    purchase = { ...ACTIVE_PURCHASE, testPurchase: {} };
    await expect(
      googlePlayProvider.verifyNotification(
        push({
          packageName: PACKAGE_NAME,
          subscriptionNotification: {
            notificationType: 4,
            purchaseToken: 'token-tester',
            subscriptionId: PRODUCT_ID,
          },
        }),
        `Bearer ${oidcToken()}`,
      ),
    ).rejects.toThrow(/never hold a real entitlement/);
  });

  it('refuses a purchase claim for a token Play does not know', async () => {
    purchaseStatus = 404;
    purchase = { error: { message: 'purchaseTokenNotFound' } };
    await expect(googlePlayProvider.readSubscription('made-up-token')).rejects.toMatchObject({
      details: [
        {
          field: 'storeSubscriptionRef',
          message: expect.stringMatching(/does not know that purchase token/),
        },
      ],
    });
  });
});
