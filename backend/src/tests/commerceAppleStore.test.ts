import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { appleStoreInternals } = await import('../commerce/services/stores/appleStore.js');
const { verifyJws, deriveStatus, toState } = appleStoreInternals;

/**
 * THE CHAIN WALK — the only thing standing between "Apple said so" and anyone with a text editor.
 *
 * An App Store notification carries the certificate that signed it, in its own header. That is
 * only worth something if the chain is walked to a root we pinned; without the anchor check,
 * forging a notification is: mint a self-signed CA, sign a payload with it, put your certs in the
 * `x5c` header, POST it. The subscription is yours, free, forever.
 *
 * So this suite builds a REAL certificate authority with openssl and signs real ES256 tokens with
 * it, rather than asserting that a mock was called. Apple's own private key is obviously not
 * available to produce a genuine positive case with, which is exactly why `verifyJws` takes its
 * trust anchor as a parameter: the walk is exercised in full against an authority we control, and
 * every caller in the adapter passes the pinned Apple root.
 *
 * The end-to-end positive case — a notification Apple actually signed — can only be produced by
 * Apple, and is covered by the sandbox purchase on a physical device.
 */

let dir = '';
let chain: { leafKey: string; x5c: string[]; rootPem: string };
/** A second, unrelated authority — the forger's CA. */
let foreign: { leafKey: string; x5c: string[]; rootPem: string };

function openssl(args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

function derBase64(pemFile: string): string {
  return new X509Certificate(readFileSync(join(dir, pemFile), 'utf8')).raw.toString('base64');
}

/** root -> intermediate -> leaf, all P-256, all currently valid. */
function buildChain(prefix: string): { leafKey: string; x5c: string[]; rootPem: string } {
  writeFileSync(join(dir, `${prefix}-ca.ext`), 'basicConstraints=critical,CA:TRUE\n');

  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${prefix}-root.key`]);
  openssl([
    'req', '-new', '-x509', '-key', `${prefix}-root.key`, '-sha256', '-days', '2',
    '-subj', `/CN=${prefix} Root`, '-out', `${prefix}-root.pem`,
  ]);

  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${prefix}-int.key`]);
  openssl([
    'req', '-new', '-key', `${prefix}-int.key`, '-subj', `/CN=${prefix} Intermediate`,
    '-out', `${prefix}-int.csr`,
  ]);
  openssl([
    'x509', '-req', '-in', `${prefix}-int.csr`, '-CA', `${prefix}-root.pem`,
    '-CAkey', `${prefix}-root.key`, '-CAcreateserial', '-days', '2', '-sha256',
    '-extfile', `${prefix}-ca.ext`, '-out', `${prefix}-int.pem`,
  ]);

  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${prefix}-leaf.key`]);
  openssl([
    'req', '-new', '-key', `${prefix}-leaf.key`, '-subj', `/CN=${prefix} Leaf`,
    '-out', `${prefix}-leaf.csr`,
  ]);
  openssl([
    'x509', '-req', '-in', `${prefix}-leaf.csr`, '-CA', `${prefix}-int.pem`,
    '-CAkey', `${prefix}-int.key`, '-CAcreateserial', '-days', '2', '-sha256',
    '-out', `${prefix}-leaf.pem`,
  ]);

  return {
    leafKey: readFileSync(join(dir, `${prefix}-leaf.key`), 'utf8'),
    x5c: [derBase64(`${prefix}-leaf.pem`), derBase64(`${prefix}-int.pem`), derBase64(`${prefix}-root.pem`)],
    rootPem: readFileSync(join(dir, `${prefix}-root.pem`), 'utf8'),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'stewra-apple-chain-'));
  chain = buildChain('ours');
  foreign = buildChain('forger');
});

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

const payloadSchema = z.object({ notificationUUID: z.string().min(1) });
const PAYLOAD = { notificationUUID: 'abc-123' };

function sign(
  payload: object,
  key: string,
  x5c: string[],
  algorithm: 'ES256' | 'HS256' = 'ES256',
): string {
  return jwt.sign(payload, algorithm === 'HS256' ? 'a-shared-secret' : key, {
    algorithm,
    header: { alg: algorithm, x5c },
  });
}

describe('the certificate chain', () => {
  it('accepts a token whose chain terminates at the anchor it was given', () => {
    const token = sign(PAYLOAD, chain.leafKey, chain.x5c);
    const anchor = new X509Certificate(chain.rootPem);
    expect(verifyJws(token, payloadSchema, anchor)).toMatchObject(PAYLOAD);
  });

  it('REFUSES a perfectly valid chain rooted at an authority it does not trust', () => {
    // The whole attack in three lines: the forger's chain is internally consistent, every
    // signature verifies, every certificate is in date. It is refused for the only reason that
    // matters — we did not pin its root.
    const token = sign(PAYLOAD, foreign.leafKey, foreign.x5c);
    const anchor = new X509Certificate(chain.rootPem);
    expect(() => verifyJws(token, payloadSchema, anchor)).toThrow(/does not terminate at the pinned/);
  });

  it('refuses a chain whose links do not join up', () => {
    // Our leaf, presented under the forger's intermediate and root.
    const spliced = [chain.x5c[0] ?? '', foreign.x5c[1] ?? '', foreign.x5c[2] ?? ''];
    const token = sign(PAYLOAD, chain.leafKey, spliced);
    const anchor = new X509Certificate(foreign.rootPem);
    expect(() => verifyJws(token, payloadSchema, anchor)).toThrow(/does not link up/);
  });

  it('refuses anything not signed ES256, however good its chain looks', () => {
    // A symmetric algorithm with a chain attached: the classic confusion, where a verifier that
    // trusts `alg` would check an HMAC against a public key it read out of the token.
    const token = sign(PAYLOAD, chain.leafKey, chain.x5c, 'HS256');
    const anchor = new X509Certificate(chain.rootPem);
    expect(() => verifyJws(token, payloadSchema, anchor)).toThrow(/ES256/);
  });

  it('refuses a token whose payload was edited after signing', () => {
    const token = sign(PAYLOAD, chain.leafKey, chain.x5c);
    const [header, , signature] = token.split('.');
    const tampered = Buffer.from(JSON.stringify({ notificationUUID: 'someone-elses' }))
      .toString('base64url');
    const anchor = new X509Certificate(chain.rootPem);
    expect(() => verifyJws(`${header}.${tampered}.${signature}`, payloadSchema, anchor)).toThrow(
      /signature does not verify/,
    );
  });

  it('refuses a header with no chain at all', () => {
    const token = jwt.sign(PAYLOAD, chain.leafKey, { algorithm: 'ES256' });
    const anchor = new X509Certificate(chain.rootPem);
    expect(() => verifyJws(token, payloadSchema, anchor)).toThrow(/x5c certificate chain/);
  });

  it('refuses a verified token whose payload is not the shape asked for', () => {
    const token = sign({ somethingElse: true }, chain.leafKey, chain.x5c);
    const anchor = new X509Certificate(chain.rootPem);
    expect(() => verifyJws(token, payloadSchema, anchor)).toThrow(/did not match the expected shape/);
  });
});

describe('the pinned root', () => {
  it('is Apple Root CA - G3, by fingerprint', () => {
    const pem = readFileSync(
      new URL('../../certs/AppleRootCA-G3.pem', import.meta.url),
      'utf8',
    );
    const cert = new X509Certificate(pem);
    expect(cert.fingerprint256).toBe(
      '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79',
    );
    // Self-signed: it is a root, not something that needs an issuer we do not have.
    expect(cert.subject).toBe(cert.issuer);
    expect(cert.subject).toContain('Apple Root CA - G3');
  });
});

describe('reading a status out of the data', () => {
  const NOW = Date.UTC(2026, 7, 15);
  const base = {
    originalTransactionId: 'ot-1',
    transactionId: 't-9',
    productId: 'com.stewra.standard.monthly',
    bundleId: 'com.stewra.app',
    environment: 'Production' as const,
  };
  const renewal = {
    originalTransactionId: 'ot-1',
    autoRenewStatus: 1 as const,
    environment: 'Production' as const,
  };

  it('is active while the paid period has time left', () => {
    expect(deriveStatus({ ...base, expiresDate: NOW + 86_400_000 }, renewal, NOW)).toBe('active');
  });

  it('is revoked the moment a revocation date exists, whatever the expiry says', () => {
    // Order matters: a refunded subscription can still be inside its paid window, and serving it
    // because the expiry has not passed is serving someone who has had their money back.
    expect(
      deriveStatus(
        { ...base, expiresDate: NOW + 86_400_000, revocationDate: NOW - 1000 },
        renewal,
        NOW,
      ),
    ).toBe('revoked');
  });

  it('is grace_period when the paid window has closed but grace has not', () => {
    expect(
      deriveStatus(
        { ...base, expiresDate: NOW - 1000 },
        { ...renewal, gracePeriodExpiresDate: NOW + 86_400_000 },
        NOW,
      ),
    ).toBe('grace_period');
  });

  it('is on_hold in billing retry — which is NOT entitled', () => {
    expect(
      deriveStatus({ ...base, expiresDate: NOW - 1000 }, { ...renewal, isInBillingRetryPeriod: true }, NOW),
    ).toBe('on_hold');
  });

  it('is expired once everything has run out', () => {
    expect(deriveStatus({ ...base, expiresDate: NOW - 1000 }, renewal, NOW)).toBe('expired');
  });

  it('reports the GRACE date as the period end while in grace, not the lapsed paid date', () => {
    const state = toState(
      { ...base, expiresDate: NOW - 1000 },
      { ...renewal, gracePeriodExpiresDate: NOW + 86_400_000 },
      NOW,
    );
    expect(state.status).toBe('grace_period');
    expect(state.currentPeriodEnd?.getTime()).toBe(NOW + 86_400_000);
  });

  it('carries the environment off the transaction, so a sandbox purchase stays sandbox', () => {
    const state = toState(
      { ...base, environment: 'Sandbox', expiresDate: NOW + 1000 },
      { ...renewal, environment: 'Sandbox' },
      NOW,
    );
    expect(state.environment).toBe('sandbox');
  });
});
