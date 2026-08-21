import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The Telnyx webhook end to end: a delivery signed with the account key lands in the inbox; a forged,
 * stale, or unsigned one is refused; delivery reports are acked and dropped. The key pair is minted
 * here so the test proves the Ed25519 wiring itself, not a recorded fixture.
 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// Telnyx publishes the raw 32-byte key, base64 — the last 32 bytes of the SPKI DER encoding.
const RAW_PUBLIC = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

process.env['TELNYX_INBOUND_SMS_ENABLED'] = 'true';
process.env['TELNYX_PUBLIC_KEY'] = RAW_PUBLIC;

const { errorHandler } = await import('../middleware/errorHandler.js');
const telnyxWebhookRoutes = (await import('../routes/telnyxWebhook.js')).default;
const { telnyxInboundSmsService } = await import('../services/telnyxInboundSmsService.js');
const { redis } = await import('../services/redisClient.js');

const app = express();
app.use('/webhooks/telnyx', telnyxWebhookRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// A number no real test line uses, so a concurrent run's inbox cannot bleed in.
const TO = `+1303${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}0`;

function envelope(params: { eventType?: string; text?: string; id?: string }): string {
  return JSON.stringify({
    data: {
      event_type: params.eventType ?? 'message.received',
      id: randomUUID(),
      payload: {
        id: params.id ?? randomUUID(),
        from: { phone_number: '+13125550100' },
        to: [{ phone_number: TO }],
        text: params.text ?? 'Your WhatsApp code is 123-456',
        received_at: new Date().toISOString(),
      },
    },
  });
}

function headers(body: string, timestamp = String(Math.floor(Date.now() / 1000)), signWith = privateKey) {
  const signature = sign(null, Buffer.from(`${timestamp}|${body}`, 'utf8'), signWith).toString('base64');
  return { 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': timestamp };
}

async function post(body: string, h: Record<string, string>): Promise<number> {
  const res = await request(API).post('/webhooks/telnyx').set(h).set('content-type', 'application/json').send(body);
  return res.status;
}

async function untilRecorded(text: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if ((await telnyxInboundSmsService.list(TO)).some((m) => m.text === text)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`"${text}" never reached the inbox`);
}

afterAll(async () => {
  await redis.del(`telnyx:inbound:${TO}`);
  server.close();
});

describe('the Telnyx inbound-SMS webhook', () => {
  it('records a delivery signed with the account key', async () => {
    const body = envelope({ text: 'Your WhatsApp code is 654-321' });
    expect(await post(body, headers(body))).toBe(200);
    await untilRecorded('Your WhatsApp code is 654-321');
    const [message] = (await telnyxInboundSmsService.list(TO)).filter((m) => m.text.includes('654-321'));
    expect(message?.from).toBe('+13125550100');
    expect(message?.to).toBe(TO);
  });

  it('refuses a delivery signed with someone else\'s key, an unsigned one, and a stale one', async () => {
    const body = envelope({ text: 'forged' });
    const { privateKey: otherKey } = generateKeyPairSync('ed25519');
    expect(await post(body, headers(body, undefined, otherKey))).toBe(401);
    expect(await post(body, {})).toBe(401);
    const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
    expect(await post(body, headers(body, stale))).toBe(401);
    expect((await telnyxInboundSmsService.list(TO)).some((m) => m.text === 'forged')).toBe(false);
  });

  it('acks a delivery report without recording anything', async () => {
    const body = envelope({ eventType: 'message.finalized', text: 'report' });
    expect(await post(body, headers(body))).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await telnyxInboundSmsService.list(TO)).some((m) => m.text === 'report')).toBe(false);
  });

  it('refuses to list a number that is not E.164', async () => {
    await expect(telnyxInboundSmsService.list('3035550100')).rejects.toThrow(/E\.164/);
  });
});
