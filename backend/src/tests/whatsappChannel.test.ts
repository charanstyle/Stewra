import { createHmac } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const APP_SECRET = 'test-app-secret';

// The middleware and sender read the master switch + secrets from config; pin them so these tests don't
// depend on whatever the developer's .env happens to say.
jest.mock('../config/unifiedConfig', () => ({
  config: {
    whatsapp: {
      enabled: true,
      phoneNumberId: '123456',
      businessNumber: '15550001111',
      accessToken: 'test-token',
      verifyToken: 'test-verify-token',
      appSecret: APP_SECRET,
      graphVersion: 'v21.0',
      graphBaseUrl: 'https://graph.example.test',
      linkCodeTtlMs: 600000,
    },
  },
}));

import { verifyWhatsappSignature } from '../middleware/verifyWhatsappSignature';
import { splitForWhatsapp } from '../services/channelSenders';
import { whatsappCloudSender } from '../services/channelSenders/whatsappCloudSender';
import { AuthenticationError } from '../utils/errors';

/** Build a request carrying `body` and the signature Meta would have sent for it. */
function signedRequest(body: string, secretUsedToSign: string = APP_SECRET): Request {
  const digest = createHmac('sha256', secretUsedToSign).update(Buffer.from(body)).digest('hex');
  return requestWith(body, `sha256=${digest}`);
}

function requestWith(body: string, signatureHeader: string | undefined): Request {
  const headers: Record<string, string> = {};
  if (signatureHeader !== undefined) headers['x-hub-signature-256'] = signatureHeader;
  const req = {
    body: Buffer.from(body),
    get: (name: string): string | undefined => headers[name.toLowerCase()],
  };
  // The middleware only touches `body` and `get`; this is the whole surface it needs.
  return req as unknown as Request;
}

const noopResponse = {} as Response;

/**
 * The webhook is UNAUTHENTICATED — Meta holds no Stewra credentials — so this HMAC is the only thing
 * standing between an attacker who guessed the URL and the agent. These tests pin that gate.
 */
describe('verifyWhatsappSignature', () => {
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  it('calls next() for a body signed with the app secret', () => {
    const next = jest.fn<void, []>() as unknown as NextFunction;
    verifyWhatsappSignature(signedRequest(payload), noopResponse, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a body signed with the WRONG secret (a forged request)', () => {
    const next = jest.fn<void, []>() as unknown as NextFunction;
    expect(() =>
      verifyWhatsappSignature(signedRequest(payload, 'attacker-guess'), noopResponse, next),
    ).toThrow(AuthenticationError);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a TAMPERED body whose signature was valid for the original', () => {
    const original = signedRequest(payload);
    const tampered = requestWith(
      JSON.stringify({ object: 'whatsapp_business_account', entry: ['injected'] }),
      original.get('x-hub-signature-256'),
    );
    expect(() => verifyWhatsappSignature(tampered, noopResponse, jest.fn() as unknown as NextFunction)).toThrow(
      AuthenticationError,
    );
  });

  it('rejects a request with no signature header at all', () => {
    expect(() =>
      verifyWhatsappSignature(requestWith(payload, undefined), noopResponse, jest.fn() as unknown as NextFunction),
    ).toThrow(AuthenticationError);
  });

  it('rejects a malformed signature header rather than crashing on it', () => {
    expect(() =>
      verifyWhatsappSignature(requestWith(payload, 'garbage'), noopResponse, jest.fn() as unknown as NextFunction),
    ).toThrow(AuthenticationError);
    // A short/odd-length hex digest must not blow up timingSafeEqual's length precondition.
    expect(() =>
      verifyWhatsappSignature(requestWith(payload, 'sha256=abcd'), noopResponse, jest.fn() as unknown as NextFunction),
    ).toThrow(AuthenticationError);
  });

  it('fails LOUD (not silently open) if the raw body was already parsed away', () => {
    const parsed = {
      body: { object: 'whatsapp_business_account' },
      get: (): string => 'sha256=deadbeef',
    } as unknown as Request;
    // A misordered router (express.json() before the webhook) must break the build/boot, never
    // "authenticate" a body it can't actually verify.
    expect(() =>
      verifyWhatsappSignature(parsed, noopResponse, jest.fn() as unknown as NextFunction),
    ).toThrow(/raw body unavailable/);
  });
});

/** Meta hard-rejects a text body over 4096 chars, so a long Stewra reply must be split, not truncated. */
describe('splitForWhatsapp', () => {
  it('leaves a short reply as a single message', () => {
    expect(splitForWhatsapp('Three meetings today; the first is at 10am.')).toEqual([
      'Three meetings today; the first is at 10am.',
    ]);
  });

  it('splits an over-long reply into parts that each fit the cap', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} about your calendar.`).join(' ');
    const parts = splitForWhatsapp(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096);
  });

  it('breaks at a word boundary, never mid-word', () => {
    const parts = splitForWhatsapp('aaa bbb ccc ddd', 7);
    // Every part must be whole words — no fragment like "cc".
    for (const part of parts) {
      for (const word of part.split(' ')) {
        expect(['aaa', 'bbb', 'ccc', 'ddd']).toContain(word);
      }
    }
  });

  it('preserves the full text across the split (nothing is dropped)', () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    expect(splitForWhatsapp(long, 100).join(' ')).toBe(long);
  });

  it('hard-cuts a single unbroken run that has no natural break', () => {
    const unbroken = 'x'.repeat(9000);
    const parts = splitForWhatsapp(unbroken);
    expect(parts.length).toBe(3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096);
    expect(parts.join('')).toBe(unbroken);
  });
});

/**
 * The Graph origin must come from config, never a literal. WHATSAPP_GRAPH_BASE_URL exists so a
 * regional/proxied Graph endpoint (or a local stand-in) is a config change rather than a code change —
 * and it silently did nothing until this was wired up, which is exactly the failure this test pins.
 */
describe('whatsappCloudSender endpoint', () => {
  const okResponse = { ok: true, status: 200, text: async (): Promise<string> => '' };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(okResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('composes the send URL from config (base URL, version, phone-number id)', async () => {
    await whatsappCloudSender.send('15550002222', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://graph.example.test/v21.0/123456/messages',
    );
  });

  it('never falls back to a hardcoded graph.facebook.com origin', async () => {
    await whatsappCloudSender.send('15550002222', 'hello');

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url.startsWith('https://graph.example.test/')).toBe(true);
    expect(url).not.toContain('graph.facebook.com');
  });

  it('sends each split part in order, to the same endpoint', async () => {
    // Two parts: the sender must issue two POSTs, sequentially, so WhatsApp renders them in order.
    await whatsappCloudSender.send('15550002222', `${'a'.repeat(4000)} ${'b'.repeat(4000)}`);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('https://graph.example.test/v21.0/123456/messages');
    }
  });
});
