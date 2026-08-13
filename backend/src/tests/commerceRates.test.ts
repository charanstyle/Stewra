import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import request from 'supertest';
import { config } from '../config/unifiedConfig.js';
import { db, closeDb } from '../database/index.js';
import { errorHandler } from '../middleware/errorHandler.js';
import rateCardRoutes from '../commerce/routes/rateCards.js';
import { rateCardRepository } from '../commerce/repositories/rateCardRepository.js';

/**
 * The operator-loaded price list (migration 050) — Phase 2.1 of the billing plan.
 *
 * What is pinned here, in order of what it would cost to lose:
 *
 *  1. The GATE. `/platform/rate-cards` answers only to accounts named in INSTALL_ADMIN_EMAILS —
 *     an org OWNER gets 404, because a client must never edit the price they are billed at, and
 *     must not even learn the surface exists.
 *  2. The TIMELINE. Loading a card closes its predecessor at exactly the new `effectiveFrom`, so
 *     any instant resolves to at most one card; a load dated into the live card's past is refused
 *     with 409, because rated messages are never re-rated.
 *  3. The REFUSALS. No fallback rate exists — an unlisted (country, category) resolves to null,
 *     not to a guess — and the tables themselves reject UPDATE and DELETE below any code path.
 */

const app = express();
app.use(express.json());
app.use('/platform/rate-cards', rateCardRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// The one email .env.test names as this install's operator. The suite creates the account itself;
// if the env and this constant drift apart the beforeAll below says so in words rather than
// letting every test fail as a mysterious 404.
const OPERATOR_EMAIL = 'install-admin@stewra.test';

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdCards: string[] = [];

function authFor(userId: string): string {
  return `Bearer ${jwt.sign({ sub: userId, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
}

async function createUser(email: string, verified = true): Promise<{ id: string; auth: string }> {
  const row = await db
    .insertInto('users')
    .values({
      email,
      display_name: 'Rates Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: verified,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return { id: row.id, auth: authFor(row.id) };
}

/**
 * A currency code no other run is using, so suites and reruns cannot fight over the one-live-card
 * slot. Starts with 'Z' to stay far from anything an operator would really load.
 */
function testCurrency(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const pick = (): string => letters[Math.floor(Math.random() * letters.length)] as string;
  return `Z${pick()}${pick()}`;
}

let operator: { id: string; auth: string };

beforeAll(async () => {
  if (!config.installAdmins.includes(OPERATOR_EMAIL)) {
    throw new Error(
      `This suite expects INSTALL_ADMIN_EMAILS in backend/.env.test to include ${OPERATOR_EMAIL}; ` +
        `it currently resolves to [${config.installAdmins.join(', ')}].`,
    );
  }
  // A crashed earlier run may have left the operator account behind; the email is unique.
  await db.deleteFrom('users').where('email', '=', OPERATOR_EMAIL).execute();
  operator = await createUser(OPERATOR_EMAIL);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // The rate tables are append-only by trigger, which is exactly what this cleanup has to step
  // around: same pattern as commerceConsent.test.ts, disable inside the transaction, delete only
  // this run's rows, re-enable before commit.
  if (createdCards.length > 0) {
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_message_rates DISABLE TRIGGER trg_commerce_message_rates_append_only`.execute(
        trx,
      );
      await sql`ALTER TABLE commerce_rate_cards DISABLE TRIGGER trg_commerce_rate_cards_close_only`.execute(
        trx,
      );
      await trx
        .deleteFrom('commerce_message_rates')
        .where('rate_card_id', 'in', createdCards)
        .execute();
      await trx.deleteFrom('commerce_rate_cards').where('id', 'in', createdCards).execute();
      await sql`ALTER TABLE commerce_rate_cards ENABLE TRIGGER trg_commerce_rate_cards_close_only`.execute(
        trx,
      );
      await sql`ALTER TABLE commerce_message_rates ENABLE TRIGGER trg_commerce_message_rates_append_only`.execute(
        trx,
      );
    });
  }
  if (createdUsers.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  await closeDb();
});

async function loadCard(
  currency: string,
  effectiveFrom: string,
  rates: Array<{ countryCallingCode: string; pricingCategory: string; amountMicros: string; unit: string }>,
): Promise<request.Response> {
  const res = await request(API).post('/platform/rate-cards').set('Authorization', operator.auth).send({
    currency,
    effectiveFrom,
    sourceNote: 'Meta rate sheet 2026-01 (test transcription)',
    rates,
  });
  if (res.status === 201) {
    createdCards.push(res.body.data.card.id as string);
  }
  return res;
}

const USD_MARKETING = { countryCallingCode: '1', pricingCategory: 'marketing', amountMicros: '25000', unit: 'per_message' };

describe('the install-admin gate', () => {
  it('lets the named operator load and read cards, and no one else even see the surface', async () => {
    const currency = testCurrency();
    const loaded = await loadCard(currency, '2026-01-01T00:00:00Z', [USD_MARKETING]);
    expect(loaded.status).toBe(201);
    expect(loaded.body.data.card.currency).toBe(currency);
    expect(loaded.body.data.card.rateCount).toBe(1);
    expect(loaded.body.data.card.effectiveTo).toBeNull();

    // An ordinary signed-in, verified account — the same class of caller as every org owner: the
    // gate is by install-operator email, so org standing is irrelevant and untested-for here.
    const outsider = await createUser(`rates-outsider-${randomUUID()}@stewra.invalid`);
    for (const probe of [
      request(API).get('/platform/rate-cards').set('Authorization', outsider.auth),
      request(API).get(`/platform/rate-cards/${loaded.body.data.card.id}`).set('Authorization', outsider.auth),
      request(API).post('/platform/rate-cards').set('Authorization', outsider.auth).send({}),
    ]) {
      const res = await probe;
      // 404, not 403: to anyone off the list the route must look unmounted, or the response
      // itself confirms there is a price surface to go looking for.
      expect(res.status).toBe(404);
    }

    // No token at all → 401 from requireAuth, same as every authenticated route.
    expect((await request(API).get('/platform/rate-cards')).status).toBe(401);
  });

  it('refuses the operator email while it is unverified — power must not attach to an unproven address', async () => {
    await db.updateTable('users').set({ email_verified: false }).where('id', '=', operator.id).execute();
    try {
      const res = await request(API).get('/platform/rate-cards').set('Authorization', operator.auth);
      expect(res.status).toBe(404);
    } finally {
      await db.updateTable('users').set({ email_verified: true }).where('id', '=', operator.id).execute();
    }
  });
});

describe('the versioned timeline', () => {
  it('a new load closes the live card at exactly its own effectiveFrom, and each instant resolves to one card', async () => {
    const currency = testCurrency();
    const first = await loadCard(currency, '2026-01-01T00:00:00Z', [USD_MARKETING]);
    expect(first.status).toBe(201);
    const second = await loadCard(currency, '2026-06-01T00:00:00Z', [
      { ...USD_MARKETING, amountMicros: '30000' },
    ]);
    expect(second.status).toBe(201);

    const detail = await request(API)
      .get(`/platform/rate-cards/${first.body.data.card.id}`)
      .set('Authorization', operator.auth);
    expect(detail.body.data.card.effectiveTo).toBe('2026-06-01T00:00:00.000Z');
    expect(detail.body.data.rates).toEqual([
      { countryCallingCode: '1', pricingCategory: 'marketing', amountMicros: '25000', unit: 'per_message' },
    ]);

    // The rater's seam: the price of a message is the price of its era.
    const during = { currency, countryCallingCode: '1', pricingCategory: 'marketing' as const };
    expect(await rateCardRepository.resolveRate({ ...during, at: new Date('2026-03-01T00:00:00Z') }))
      .toEqual({ rateCardId: first.body.data.card.id, amountMicros: 25000n, unit: 'per_message' });
    expect(await rateCardRepository.resolveRate({ ...during, at: new Date('2026-07-01T00:00:00Z') }))
      .toEqual({ rateCardId: second.body.data.card.id, amountMicros: 30000n, unit: 'per_message' });
    // Before any card existed there is no price — not the first card's price projected backwards.
    expect(await rateCardRepository.resolveRate({ ...during, at: new Date('2025-12-01T00:00:00Z') }))
      .toBeNull();
  });

  it('refuses a load dated into the live card\'s past — history is never re-rated', async () => {
    const currency = testCurrency();
    expect((await loadCard(currency, '2026-06-01T00:00:00Z', [USD_MARKETING])).status).toBe(201);

    const backdated = await loadCard(currency, '2026-03-01T00:00:00Z', [USD_MARKETING]);
    expect(backdated.status).toBe(409);
    // Same instant is just as refused as earlier: it would give the closed card an empty window.
    const sameInstant = await loadCard(currency, '2026-06-01T00:00:00Z', [USD_MARKETING]);
    expect(sameInstant.status).toBe(409);

    const cards = await request(API).get('/platform/rate-cards').set('Authorization', operator.auth);
    const mine = cards.body.data.cards.filter((c: { currency: string }) => c.currency === currency);
    expect(mine).toHaveLength(1);
    expect(mine[0].effectiveTo).toBeNull();
  });
});

describe('the refusals', () => {
  it('a missing (country, category) resolves to null — there is no fallback rate', async () => {
    const currency = testCurrency();
    const loaded = await loadCard(currency, '2026-01-01T00:00:00Z', [USD_MARKETING]);
    expect(loaded.status).toBe(201);
    const at = new Date('2026-02-01T00:00:00Z');
    // Listed country, unlisted category.
    expect(
      await rateCardRepository.resolveRate({ currency, at, countryCallingCode: '1', pricingCategory: 'utility' }),
    ).toBeNull();
    // Unlisted country, listed category.
    expect(
      await rateCardRepository.resolveRate({ currency, at, countryCallingCode: '91', pricingCategory: 'marketing' }),
    ).toBeNull();
  });

  it('refuses a load that contradicts itself, naming every bad row', async () => {
    const currency = testCurrency();
    const res = await loadCard(currency, '2026-01-01T00:00:00Z', [
      USD_MARKETING,
      { ...USD_MARKETING }, // duplicate (country, category)
      { ...USD_MARKETING, countryCallingCode: '999' }, // not an assigned calling code
    ]);
    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('rates.1');
    expect(fields).toContain('rates.2.countryCallingCode');

    expect((await loadCard(currency, '2026-01-01T00:00:00Z', [])).status).toBe(400);
    // Nothing partial was written by the refused loads.
    const cards = await request(API).get('/platform/rate-cards').set('Authorization', operator.auth);
    expect(cards.body.data.cards.filter((c: { currency: string }) => c.currency === currency)).toHaveLength(0);
  });

  it('the tables themselves reject UPDATE and DELETE, below any code path', async () => {
    const currency = testCurrency();
    const loaded = await loadCard(currency, '2026-01-01T00:00:00Z', [USD_MARKETING]);
    const cardId = loaded.body.data.card.id as string;

    // Raw SQL on purpose: the Kysely column type already types amount_micros as never-updatable,
    // so the code path this simulates is the one that bypassed the types.
    await expect(
      sql`UPDATE commerce_message_rates SET amount_micros = '1' WHERE rate_card_id = ${cardId}`.execute(db),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.deleteFrom('commerce_message_rates').where('rate_card_id', '=', cardId).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.deleteFrom('commerce_rate_cards').where('id', '=', cardId).execute(),
    ).rejects.toThrow(/append-only/);
    // Editing anything but the closing transition is refused — including re-opening a closed card
    // or shifting a live card's era.
    await expect(
      db.updateTable('commerce_rate_cards').set({ source_note: 'edited' }).where('id', '=', cardId).execute(),
    ).rejects.toThrow(/only be closed/);
  });
});
