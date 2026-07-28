import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';

/**
 * No module in this file is mocked. Everything below runs the real thing:
 *
 *   * the real `unifiedConfig` — its real Zod schema, parsing real environment variables, including the
 *     real "WHATSAPP_ENABLED=true requires ..." guard. The old version of this suite `vi.mock`ed the
 *     config module, which meant a typo in the schema, a missing post-parse guard, or a `graphBaseUrl`
 *     that never actually reached the sender were all invisible here.
 *   * the real Express router, real `express.raw()`, real HTTP, real `errorHandler` — so the assertions
 *     are on status codes a caller would genuinely receive, not on whether a spy was invoked.
 *   * a real HTTP server on a real port, standing in for Meta's Graph host. The sender makes a real
 *     `fetch` over a real socket. Nothing patches `globalThis.fetch`.
 *
 * Env has to be set BEFORE `unifiedConfig` is imported (it parses at import time), which is why the
 * modules under test are pulled in with `await import` below rather than by static import.
 */

// Generated, never hardcoded: a literal here would be a committed secret, and generating it also proves
// the config pipeline plumbs through whatever value it is handed rather than a baked-in default.
const APP_SECRET = randomBytes(32).toString('hex');
const ACCESS_TOKEN = `test-access-${randomBytes(8).toString('hex')}`;
const PHONE_NUMBER_ID = '123456';
const GRAPH_VERSION = 'v21.0';

/** One real inbound HTTP request, as our stand-in Graph host actually received it off the wire. */
interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly body: string;
}

const receivedRequests: ReceivedRequest[] = [];

/**
 * A real HTTP server playing the role of Meta's Graph host.
 *
 * This is not a stand-in for the *sender* — the sender is real, and so is its `fetch`. It is a real
 * server at the other end of a real socket, which is what `WHATSAPP_GRAPH_BASE_URL` exists to allow
 * (see the comment on that var in unifiedConfig). Because we own the origin, "the sender did not fall
 * back to graph.facebook.com" is proven by this server having received the request at all.
 */
const graphServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    receivedRequests.push({
      method: req.method ?? '',
      path: req.url ?? '',
      authorization: req.headers.authorization ?? '',
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

await new Promise<void>((resolve) => graphServer.listen(0, '127.0.0.1', resolve));
const graphOrigin = `http://127.0.0.1:${(graphServer.address() as AddressInfo).port}`;

// Pinned explicitly rather than read from the developer's .env, so this suite gives the same answer on
// every machine. Set before the import below, and dotenv does not override an already-set process.env.
process.env['WHATSAPP_ENABLED'] = 'true';
process.env['WHATSAPP_PHONE_NUMBER_ID'] = PHONE_NUMBER_ID;
process.env['WHATSAPP_BUSINESS_NUMBER'] = '15550001111';
process.env['WHATSAPP_ACCESS_TOKEN'] = ACCESS_TOKEN;
process.env['WHATSAPP_VERIFY_TOKEN'] = `test-verify-${randomBytes(8).toString('hex')}`;
process.env['WHATSAPP_APP_SECRET'] = APP_SECRET;
process.env['WHATSAPP_GRAPH_VERSION'] = GRAPH_VERSION;
process.env['WHATSAPP_GRAPH_BASE_URL'] = graphOrigin;

// Required by the schema for any import of the config at all. Nothing in this file opens a database
// connection or mints a token, so these only have to satisfy the shape the schema demands.
process.env['DATABASE_URL'] ??= 'postgresql://unused:unused@127.0.0.1:1/unused-by-this-suite';
process.env['JWT_SECRET'] ??= randomBytes(32).toString('hex');
process.env['VAULT_KEY'] ??= randomBytes(32).toString('hex');
process.env['WEB_APP_URL'] ??= 'http://127.0.0.1:5173';
process.env['GOOGLE_CLIENT_ID'] ??= 'unused-by-this-suite.apps.googleusercontent.com';
process.env['GOOGLE_CLIENT_SECRET'] ??= 'unused-by-this-suite';
process.env['GOOGLE_REDIRECT_URI'] ??= 'http://127.0.0.1:3001/auth/google/callback';
process.env['GMAIL_LOOKBACK_DAYS'] ??= '7';
process.env['SMTP_HOST'] ??= '127.0.0.1';
process.env['SMTP_PORT'] ??= '465';
process.env['SMTP_SECURE'] ??= 'true';
process.env['SMTP_USER'] ??= 'unused-by-this-suite';
process.env['SMTP_PASSWORD'] ??= 'unused-by-this-suite';
process.env['EMAIL_FROM'] ??= 'stewra@unused-by-this-suite.test';
process.env['REDIS_URL'] ??= 'redis://127.0.0.1:6379';

const { config } = await import('../config/unifiedConfig.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { verifyWhatsappSignature } = await import('../middleware/verifyWhatsappSignature.js');
const { splitForWhatsapp } = await import('../services/channelSenders/index.js');
const { whatsappCloudSender } = await import('../services/channelSenders/whatsappCloudSender.js');

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    graphServer.close((err) => (err ? reject(err) : resolve())),
  );
});

/** The HMAC Meta would attach to exactly these bytes. */
function signature(body: string, secretUsedToSign: string = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secretUsedToSign).update(Buffer.from(body)).digest('hex')}`;
}

/**
 * A real Express app mounting the real middleware and the real terminal error handler.
 *
 * `rawBody: false` reproduces a MISORDERED router (express.json() ahead of the webhook), which is a
 * real deployment mistake rather than a hypothetical — hence a test for it.
 */
function webhookApp(options: { rawBody: boolean } = { rawBody: true }): express.Express {
  const app = express();
  app.post(
    '/webhooks/whatsapp',
    options.rawBody ? express.raw({ type: '*/*' }) : express.json({ type: '*/*' }),
    verifyWhatsappSignature,
    (_req, res) => {
      res.status(200).json({ success: true });
    },
  );
  app.use(errorHandler);
  return app;
}

/**
 * The webhook is UNAUTHENTICATED — Meta holds no Stewra credentials — so this HMAC is the only thing
 * standing between an attacker who guessed the URL and the agent. These tests pin that gate, over real
 * HTTP, so what they assert is the status code an attacker would actually get back.
 */
describe('POST /webhooks/whatsapp signature gate', () => {
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  it('accepts a body signed with the app secret', async () => {
    await request(webhookApp())
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signature(payload))
      .send(payload)
      .expect(200, { success: true });
  });

  it('rejects a body signed with the WRONG secret (a forged request)', async () => {
    // The test that matters: an attacker who can reach the URL but does not hold the app secret.
    const response = await request(webhookApp())
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signature(payload, 'attacker-guess'))
      .send(payload)
      .expect(401);

    expect(response.body.success).toBe(false);
  });

  it('rejects a TAMPERED body whose signature was valid for the original', async () => {
    const tampered = JSON.stringify({ object: 'whatsapp_business_account', entry: ['injected'] });

    await request(webhookApp())
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signature(payload))
      .send(tampered)
      .expect(401);
  });

  it('rejects a request with no signature header at all', async () => {
    await request(webhookApp())
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .send(payload)
      .expect(401);
  });

  it('rejects a malformed signature header rather than crashing on it', async () => {
    await request(webhookApp())
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', 'garbage')
      .send(payload)
      .expect(401);

    // A short/odd-length hex digest must not blow up timingSafeEqual's length precondition.
    await request(webhookApp())
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', 'sha256=abcd')
      .send(payload)
      .expect(401);
  });

  it('fails LOUD (not silently open) when the router is misordered and the raw body is gone', async () => {
    // express.json() ahead of the webhook leaves a parsed object on req.body, so there are no original
    // bytes left to verify. That must surface as a 500, never as an authenticated request.
    const response = await request(webhookApp({ rawBody: false }))
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signature(payload))
      .send(payload)
      .expect(500);

    expect(response.body.error.code).toBe('INTERNAL_ERROR');
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
 * and it silently did nothing until this was wired up, which is exactly the failure this pins.
 *
 * Every assertion below is on a request that genuinely crossed a socket into the server above. If the
 * sender ignored the configured origin, `receivedRequests` would simply be empty.
 */
describe('whatsappCloudSender against a real Graph endpoint', () => {
  const expectedPath = `/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  beforeEach(() => {
    receivedRequests.length = 0;
  });

  it('reads the Graph origin from config rather than a hardcoded default', () => {
    // Guards the test itself: if this ever reverted to graph.facebook.com, the assertions below would
    // be attempting real calls to Meta, and their failure would be confusing rather than obvious.
    expect(config.whatsapp.graphBaseUrl).toBe(graphOrigin);
  });

  it('composes the send URL from config (base URL, version, phone-number id)', async () => {
    await whatsappCloudSender.send('15550002222', 'hello');

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]?.method).toBe('POST');
    expect(receivedRequests[0]?.path).toBe(expectedPath);
  });

  it('authenticates the call with the configured access token', async () => {
    await whatsappCloudSender.send('15550002222', 'hello');

    // A send that reaches Meta without this header is rejected there, which is invisible from our side.
    expect(receivedRequests[0]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('sends the text as a WhatsApp individual text message', async () => {
    await whatsappCloudSender.send('15550002222', 'hello');

    expect(JSON.parse(receivedRequests[0]?.body ?? '{}')).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550002222',
      type: 'text',
      text: { preview_url: false, body: 'hello' },
    });
  });

  it('sends each split part in order, to the same endpoint', async () => {
    // Two parts: the sender must issue two POSTs, sequentially, so WhatsApp renders them in order.
    await whatsappCloudSender.send('15550002222', `${'a'.repeat(4000)} ${'b'.repeat(4000)}`);

    expect(receivedRequests).toHaveLength(2);
    for (const received of receivedRequests) expect(received.path).toBe(expectedPath);

    const bodies = receivedRequests.map((r) => String(JSON.parse(r.body).text.body));
    expect(bodies[0]?.startsWith('a')).toBe(true);
    expect(bodies[1]?.startsWith('b')).toBe(true);
  });

  it('throws with the status and body when Graph rejects the send', async () => {
    // Now that a real server answers, the failure path is reachable without patching anything: a reply
    // that never left the building must surface loudly, not be swallowed.
    const failing = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }));
    });
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    const failingOrigin = `http://127.0.0.1:${(failing.address() as AddressInfo).port}`;
    const originalBaseUrl = config.whatsapp.graphBaseUrl;

    try {
      // The config object is what the sender reads on every call, so pointing it at the failing server
      // is the same switch a deploy would make — no interception involved.
      Object.defineProperty(config.whatsapp, 'graphBaseUrl', {
        value: failingOrigin,
        configurable: true,
      });

      await expect(whatsappCloudSender.send('15550002222', 'hello')).rejects.toThrow(
        /WhatsApp send failed \(401\).*Invalid OAuth access token/s,
      );
    } finally {
      Object.defineProperty(config.whatsapp, 'graphBaseUrl', {
        value: originalBaseUrl,
        configurable: true,
      });
      await new Promise<void>((resolve, reject) =>
        failing.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
