import { z } from 'zod';
import type { InboundSms } from '@stewra/shared-types';
import { redis } from './redisClient.js';

/** Kept one hour, newest last, at most this many per number — an inbox for codes, not an archive. */
const RETENTION_SECONDS = 60 * 60;
const MAX_PER_NUMBER = 50;
const E164 = /^\+[1-9]\d{6,14}$/;

/** What `record` wrote; a row that does not parse is corruption, not a message to skip. */
const storedSchema = z.object({
  from: z.string(),
  to: z.string(),
  text: z.string(),
  receivedAt: z.string(),
  providerMessageId: z.string(),
});

function key(to: string): string {
  return `telnyx:inbound:${to}`;
}

/**
 * The install's inbox of inbound SMS on its own Telnyx numbers. Redis rather than a table on purpose:
 * the content is a verification code that is worthless in an hour and must not outlive that, and
 * nothing in the product reads it — only an operator (or an e2e run acting as one) polling for a code.
 */
export const telnyxInboundSmsService = {
  async record(message: InboundSms): Promise<void> {
    if (!E164.test(message.to)) throw new Error(`telnyx inbound: recipient is not E.164: ${message.to}`);
    const k = key(message.to);
    await redis
      .multi()
      .rpush(k, JSON.stringify(message))
      .ltrim(k, -MAX_PER_NUMBER, -1)
      .expire(k, RETENTION_SECONDS)
      .exec();
  },

  async list(to: string): Promise<InboundSms[]> {
    if (!E164.test(to)) throw new Error(`telnyx inbound: number is not E.164: ${to}`);
    const rows = await redis.lrange(key(to), 0, -1);
    return rows.map((row): InboundSms => storedSchema.parse(JSON.parse(row)));
  },
};
