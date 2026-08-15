import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
 * Apple, over plain `fetch` and `node:crypto` — same posture as `metaGraph.ts` and the Stripe
 * adapter: no vendor SDK, responses parsed with zod rather than asserted, and a misconfigured
 * integration that refuses instead of degrading.
 *
 * Two things Apple does that shape everything here:
 *
 * **Everything is a JWS, including the parts inside the JWS.** A notification is a signed payload
 * whose `data` contains two more signed payloads (the transaction and the renewal info). Each is
 * verified independently against Apple's certificate chain. Verifying the outer one and then
 * trusting its contents would mean trusting a nested blob nobody checked.
 *
 * **The chain is the authentication.** The signing certificate travels in the JWS header (`x5c`),
 * so the token carries its own claim to be trustworthy. That is worth nothing unless the chain is
 * walked all the way to a root we pinned ourselves — otherwise anyone can mint a certificate, put
 * it in the header, and sign whatever they like. `AppleRootCA-G3.pem` is committed next to this
 * code and its fingerprint is checked on load, so the trust anchor cannot be swapped by anything
 * short of a commit.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Apple Root CA - G3, SHA-256 fingerprint. Pinned as a second lock on the file itself: a PEM in
 * the repo could be replaced by a bad merge or a careless "cert refresh", and this constant makes
 * that a startup failure rather than a silently weakened trust anchor.
 */
const APPLE_ROOT_SHA256 =
  '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';

/** Loaded once, at first use, and never re-read. A missing or wrong root is fatal, not a warning. */
let rootCert: X509Certificate | null = null;

function appleRoot(): X509Certificate {
  if (rootCert !== null) return rootCert;
  const path = resolve(HERE, '../../../../certs/AppleRootCA-G3.pem');
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Apple's root certificate is missing at ${path}. It is committed to this repository; ` +
        'restore it (or re-fetch https://www.apple.com/certificateauthority/AppleRootCA-G3.cer ' +
        'and convert it with openssl) — App Store notifications cannot be verified without it.',
      { cause: error },
    );
  }
  const cert = new X509Certificate(pem);
  if (cert.fingerprint256 !== APPLE_ROOT_SHA256) {
    throw new Error(
      `The certificate at ${path} is not Apple Root CA - G3: expected SHA-256 ${APPLE_ROOT_SHA256}, ` +
        `found ${cert.fingerprint256}. Refusing to trust it.`,
    );
  }
  rootCert = cert;
  return cert;
}

function appleConfig(): {
  bundleId: string;
  issuerId: string;
  keyId: string;
  privateKey: string;
  environment: 'sandbox' | 'production';
  apiBaseUrl: string;
} {
  const cfg = config.appleStore;
  if (!cfg.enabled) {
    throw new ServiceUnavailableError('The App Store integration is not configured.');
  }
  return cfg;
}

/** The only JWS header shape this accepts: ES256, with a full chain to verify it against. */
const jwsHeaderSchema = z.object({
  alg: z.string().min(1),
  x5c: z.array(z.string().min(1)).min(3),
});

/**
 * Verify a JWS the way Apple signs them: ES256, with the signing chain in `x5c`.
 *
 * Order matters and every step is a refusal:
 *  1. the header must carry a chain of at least leaf + intermediate + root;
 *  2. each certificate must be currently valid — an expired leaf is not a valid signer, and
 *     checking this ourselves is necessary because a signature check alone does not look at dates;
 *  3. each link must actually be issued by, and verify against, the next one up;
 *  4. the top of the chain must BE our pinned root, compared by raw bytes rather than by subject
 *     name, which anyone can type;
 *  5. only then is the signature checked, with the leaf's key.
 */
function verifyJws<S extends z.ZodTypeAny>(
  token: string,
  schema: S,
  /**
   * The trust anchor. A parameter so the chain logic can be exercised against a generated
   * authority in tests — Apple's private key is not available to forge a positive case with, and
   * an unverified chain-walker is worth nothing.
   *
   * This is a seam, not a backdoor: every caller in this file passes `appleRoot()`, and nothing
   * reads an anchor from config, env, or a request. Overriding it requires editing this file.
   */
  anchor: X509Certificate,
): z.infer<S> {
  const decoded = jwt.decode(token, { complete: true });
  if (decoded === null || typeof decoded === 'string') {
    throw new AuthenticationError('That App Store payload is not a JWS.');
  }
  const header = jwsHeaderSchema.safeParse(decoded.header);
  if (!header.success) {
    throw new AuthenticationError(
      'That App Store payload has no usable ES256 header with a full x5c certificate chain.',
    );
  }
  if (header.data.alg !== 'ES256') {
    throw new AuthenticationError(
      `App Store payloads are signed ES256; this one claims ${header.data.alg}.`,
    );
  }
  const chain = header.data.x5c.map((b64) => {
    try {
      return new X509Certificate(Buffer.from(b64, 'base64'));
    } catch (error) {
      throw new AuthenticationError(
        `A certificate in the x5c chain does not parse: ${String(error)}`,
      );
    }
  });

  const now = Date.now();
  for (const cert of chain) {
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) {
      throw new AuthenticationError(
        `A certificate in the App Store chain is outside its validity window (${cert.subject}).`,
      );
    }
  }
  for (let i = 0; i < chain.length - 1; i += 1) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (child === undefined || parent === undefined || !child.checkIssued(parent)) {
      throw new AuthenticationError('The App Store certificate chain does not link up.');
    }
    if (!child.verify(parent.publicKey)) {
      throw new AuthenticationError('A link in the App Store certificate chain fails verification.');
    }
  }

  // Compared by bytes. A certificate whose SUBJECT reads "Apple Root CA - G3" proves nothing —
  // that string is free to type — so the anchor check is equality with the pinned DER.
  const top = chain[chain.length - 1];
  if (top === undefined || !top.raw.equals(anchor.raw)) {
    throw new AuthenticationError(
      'The App Store certificate chain does not terminate at the pinned Apple Root CA - G3.',
    );
  }

  const leaf = chain[0];
  if (leaf === undefined) {
    throw new AuthenticationError('The App Store certificate chain has no leaf.');
  }
  let payload: unknown;
  try {
    // `leaf.publicKey` is already a public KeyObject — passing it through `createPublicKey` throws,
    // because that expects key material or a PRIVATE key to derive from.
    payload = jwt.verify(token, leaf.publicKey, { algorithms: ['ES256'] });
  } catch (error) {
    throw new AuthenticationError(
      `That App Store payload's signature does not verify: ${String(error)}`,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new AuthenticationError(
      `That App Store payload verified but did not match the expected shape: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** Apple sends epoch MILLISECONDS. Anything else is a shape error, not something to coerce. */
const epochMillis = z.number().int().nonnegative();

const transactionInfoSchema = z.object({
  originalTransactionId: z.string().min(1),
  transactionId: z.string().min(1),
  productId: z.string().min(1),
  bundleId: z.string().min(1),
  environment: z.enum(['Sandbox', 'Production']),
  expiresDate: epochMillis.optional(),
  revocationDate: epochMillis.optional(),
});

const renewalInfoSchema = z.object({
  originalTransactionId: z.string().min(1),
  autoRenewStatus: z.union([z.literal(0), z.literal(1)]),
  environment: z.enum(['Sandbox', 'Production']),
  gracePeriodExpiresDate: epochMillis.optional(),
  isInBillingRetryPeriod: z.boolean().optional(),
});

const notificationSchema = z.object({
  notificationType: z.string().min(1),
  subtype: z.string().min(1).optional(),
  notificationUUID: z.string().min(1),
  data: z
    .object({
      signedTransactionInfo: z.string().min(1).optional(),
      signedRenewalInfo: z.string().min(1).optional(),
    })
    .optional(),
});

const subscriptionStatusSchema = z.object({
  environment: z.enum(['Sandbox', 'Production']),
  bundleId: z.string().min(1),
  data: z.array(
    z.object({
      lastTransactions: z.array(
        z.object({
          originalTransactionId: z.string().min(1),
          status: z.number().int(),
          signedTransactionInfo: z.string().min(1),
          signedRenewalInfo: z.string().min(1),
        }),
      ),
    }),
  ),
});

type TransactionInfo = z.infer<typeof transactionInfoSchema>;
type RenewalInfo = z.infer<typeof renewalInfoSchema>;

/**
 * Derive the status from the DATA, not from the notification type.
 *
 * Apple has added notification types repeatedly and will again; a switch over their names is a
 * thing that silently stops covering cases. The transaction and renewal payloads answer the only
 * question that matters directly — is there a revocation, has the paid period ended, is there
 * grace left, is Apple still retrying the card — and those four facts have not changed shape in
 * years. `DID_RENEW` and `EXPIRED` become the same code path, which is the point.
 */
function deriveStatus(
  transaction: TransactionInfo,
  renewal: RenewalInfo,
  now: number,
): StoreSubscriptionStatus {
  if (transaction.revocationDate !== undefined) return 'revoked';
  if (transaction.expiresDate !== undefined && transaction.expiresDate > now) return 'active';
  if (renewal.gracePeriodExpiresDate !== undefined && renewal.gracePeriodExpiresDate > now) {
    return 'grace_period';
  }
  if (renewal.isInBillingRetryPeriod === true) return 'on_hold';
  return 'expired';
}

function toState(
  transaction: TransactionInfo,
  renewal: RenewalInfo,
  now: number,
): StoreSubscriptionState {
  const status = deriveStatus(transaction, renewal, now);
  const environment = transaction.environment === 'Sandbox' ? 'sandbox' : 'production';
  // "Entitled until" — which during grace is the grace date, not the lapsed paid-period date.
  const periodEnd =
    status === 'grace_period' && renewal.gracePeriodExpiresDate !== undefined
      ? renewal.gracePeriodExpiresDate
      : transaction.expiresDate;
  return {
    store: 'apple',
    environment,
    productId: transaction.productId,
    storeSubscriptionRef: transaction.originalTransactionId,
    latestTransactionRef: transaction.transactionId,
    status,
    currentPeriodEnd: periodEnd === undefined ? null : new Date(periodEnd),
    autoRenewing: renewal.autoRenewStatus === 1,
  };
}

/**
 * Refuse anything that is not this install's app, on this install's ledger.
 *
 * The bundle check stops another developer's notification — or a replayed one from a different
 * app — being applied here. The environment check matters more: Apple delivers sandbox and
 * production notifications to the SAME url, so without this a tester's free sandbox purchase
 * would grant a real, paid entitlement.
 */
function assertOurs(params: { bundleId: string; environment: 'sandbox' | 'production' }): void {
  const cfg = appleConfig();
  if (params.bundleId !== cfg.bundleId) {
    throw new AuthenticationError(
      `That App Store payload is for bundle ${params.bundleId}, not ${cfg.bundleId}.`,
    );
  }
  if (params.environment !== cfg.environment) {
    throw new AuthenticationError(
      `That App Store payload is from the ${params.environment} ledger; this install is ` +
        `${cfg.environment}. A sandbox purchase must never grant a production entitlement.`,
    );
  }
}

class AppleStoreProvider implements StoreProvider {
  readonly store = 'apple' as const;

  async verifyNotification(rawBody: Buffer): Promise<StoreNotification> {
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AuthenticationError('That App Store delivery is not JSON.');
    }
    const envelope = z.object({ signedPayload: z.string().min(1) }).safeParse(body);
    if (!envelope.success) {
      throw new AuthenticationError('That App Store delivery carries no signedPayload.');
    }

    const notification = verifyJws(envelope.data.signedPayload, notificationSchema, appleRoot());
    const subtype = notification.subtype ?? null;

    // TEST pings and the events carrying no subscription (price-consent prompts, and whatever
    // Apple adds next) verify fine and mean nothing here. ACK them: a store that does not get its
    // 200 retries for hours.
    const signedTransaction = notification.data?.signedTransactionInfo;
    const signedRenewal = notification.data?.signedRenewalInfo;
    if (signedTransaction === undefined || signedRenewal === undefined) {
      return {
        kind: 'ignored',
        notificationRef: notification.notificationUUID,
        notificationType: notification.notificationType,
        subtype,
        reason: 'the notification carries no transaction and renewal info',
      };
    }

    // Each nested payload verified in its own right — the outer signature says nothing about these.
    const transaction = verifyJws(signedTransaction, transactionInfoSchema, appleRoot());
    const renewal = verifyJws(signedRenewal, renewalInfoSchema, appleRoot());
    if (renewal.originalTransactionId !== transaction.originalTransactionId) {
      throw new AuthenticationError(
        'That App Store notification pairs a transaction and a renewal for different subscriptions.',
      );
    }
    const state = toState(transaction, renewal, Date.now());
    assertOurs({ bundleId: transaction.bundleId, environment: state.environment });

    return {
      kind: 'subscription',
      notificationRef: notification.notificationUUID,
      notificationType: notification.notificationType,
      subtype,
      state,
    };
  }

  async readSubscription(storeSubscriptionRef: string): Promise<StoreSubscriptionState> {
    const cfg = appleConfig();
    const token = jwt.sign({ bid: cfg.bundleId }, cfg.privateKey, {
      algorithm: 'ES256',
      keyid: cfg.keyId,
      issuer: cfg.issuerId,
      audience: 'appstoreconnect-v1',
      expiresIn: '10m',
    });

    const url = `${cfg.apiBaseUrl}/inApps/v1/subscriptions/${encodeURIComponent(storeSubscriptionRef)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    if (!response.ok) {
      // 404 is the ordinary "we do not know that transaction" — a claim for a purchase that does
      // not exist on this ledger. A validation failure so the caller's request is refused, rather
      // than retried forever as though Apple were down.
      if (response.status === 404) {
        throw new ValidationError('Validation failed', [
          {
            field: 'storeSubscriptionRef',
            message: 'Apple does not know that subscription on this ledger.',
          },
        ]);
      }
      throw new Error(`Apple refused the subscription lookup: HTTP ${response.status} ${text}`);
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      throw new Error('Apple returned a subscription lookup that is not JSON.');
    }
    const parsed = subscriptionStatusSchema.safeParse(parsedBody);
    if (!parsed.success) {
      throw new Error('Apple returned a subscription lookup that did not match the expected shape.');
    }

    // Apple groups by subscription group; the one asked about is the one whose
    // originalTransactionId matches, and there is exactly one.
    const found = parsed.data.data
      .flatMap((group) => group.lastTransactions)
      .find((t) => t.originalTransactionId === storeSubscriptionRef);
    if (found === undefined) {
      throw new ValidationError('Validation failed', [
        {
          field: 'storeSubscriptionRef',
          message: 'Apple returned no transaction for that subscription.',
        },
      ]);
    }

    const transaction = verifyJws(found.signedTransactionInfo, transactionInfoSchema, appleRoot());
    const renewal = verifyJws(found.signedRenewalInfo, renewalInfoSchema, appleRoot());
    const state = toState(transaction, renewal, Date.now());
    assertOurs({ bundleId: transaction.bundleId, environment: state.environment });

    logger.info('commerce stores: read an App Store subscription', {
      storeSubscriptionRef,
      status: state.status,
      environment: state.environment,
    });
    return state;
  }
}

export const appleStoreProvider = new AppleStoreProvider();

/** Exported for the suite that drives the chain checks with a generated certificate authority. */
export const appleStoreInternals = { verifyJws, deriveStatus, toState };
