import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';

/**
 * THE MANUAL HALF of the payment seam — the DEFAULT. This install moves no money: an operator
 * attests offline settlements with mark-paid, the charge surface refuses by name, and the
 * payments webhook treats every delivery as forged because under `manual` none can be genuine.
 */

process.env['META_COMMERCE_ENABLED'] = 'true';
process.env['META_COMMERCE_APP_ID'] = '100000000000001';
process.env['META_COMMERCE_APP_SECRET'] = randomBytes(32).toString('hex');
process.env['META_COMMERCE_CONFIG_ID'] = '200000000000002';
process.env['META_COMMERCE_VERIFY_TOKEN'] = `verify-${randomBytes(8).toString('hex')}`;
process.env['META_COMMERCE_GRAPH_BASE_URL'] = 'http://127.0.0.1:9';
// COMMERCE_BILLING_PROVIDER deliberately unset: `manual` must be what an unconfigured install gets.
delete process.env['COMMERCE_BILLING_PROVIDER'];

const database = (await import('../database/index.js')) as {
  db: typeof dbType;
  closeDb: typeof closeDbType;
};
const { db } = database;
const { config } = await import('../config/unifiedConfig.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const billingRoutes = (await import('../commerce/routes/billing.js')).default;
const paymentsWebhookRoutes = (await import('../commerce/routes/paymentsWebhook.js')).default;
const { organizationRepository } = await import(
  '../commerce/repositories/organizationRepository.js'
);
const { invoiceRepository } = await import('../commerce/repositories/invoiceRepository.js');
const { paymentService } = await import('../commerce/services/paymentService.js');
const { ValidationError } = await import('../utils/errors.js');

const app = express();
app.use('/webhooks/payments', paymentsWebhookRoutes);
app.use(express.json());
app.use('/platform/billing', billingRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdOrgs: string[] = [];
const createdUsers: string[] = [];

const CUR = `Z${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}`;
const TOTAL = 250_000n;

// Fifth address in the test INSTALL_ADMIN_EMAILS list; one per billing-adjacent suite so parallel
// runs never race to create the same unique email.
const OPERATOR_EMAIL = 'manual-billing-admin@stewra.test';

const now = new Date();
const LAST_MONTH = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  .toISOString()
  .slice(0, 10);
const THIS_MONTH = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  .toISOString()
  .slice(0, 10);

function bearer(userId: string): string {
  return `Bearer ${jwt.sign({ sub: userId, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
}

async function createUser(email: string): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({
      email,
      display_name: 'Manual Payments Tester',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

async function org(): Promise<string> {
  const userId = await createUser(`manual-${randomUUID()}@stewra.invalid`);
  const { org: created } = await organizationRepository.create({
    name: 'Manual Payments Org',
    slug: `manual-${randomUUID().slice(0, 12)}`,
    createdBy: userId,
  });
  createdOrgs.push(created.id);
  return created.id;
}

async function invoiceFor(orgId: string, issue: boolean): Promise<string> {
  const invoice = await invoiceRepository.writeCloseOutcome({
    orgId,
    currency: CUR,
    periodStart: LAST_MONTH,
    periodEnd: THIS_MONTH,
    lines: [
      { kind: 'message_costs', description: 'test pass-through', quantity: 1, amountMicros: TOTAL },
    ],
    unratedBillable: issue ? 0 : 1,
    unpricedMessages: 0,
    issue,
  });
  return invoice.id;
}

let operatorId = '';

beforeAll(async () => {
  operatorId = await createUser(OPERATOR_EMAIL);
  if (!config.installAdmins.includes(OPERATOR_EMAIL)) {
    throw new Error(
      `INSTALL_ADMIN_EMAILS must include ${OPERATOR_EMAIL} for this suite (fix backend/.env.test and ci.yml)`,
    );
  }
  if (config.commerceBilling.provider !== 'manual') {
    throw new Error('this suite exists to test the default provider; the environment overrode it');
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE commerce_invoice_lines DISABLE TRIGGER trg_commerce_invoice_lines_draft_only`.execute(trx);
      await sql`ALTER TABLE commerce_invoices DISABLE TRIGGER trg_commerce_invoices_issued_immutable`.execute(trx);
      await trx
        .deleteFrom('commerce_payment_attempts')
        .where(
          'invoice_id',
          'in',
          trx.selectFrom('commerce_invoices').select('id').where('org_id', 'in', createdOrgs),
        )
        .execute();
      await trx
        .deleteFrom('commerce_invoice_lines')
        .where(
          'invoice_id',
          'in',
          trx.selectFrom('commerce_invoices').select('id').where('org_id', 'in', createdOrgs),
        )
        .execute();
      await trx.deleteFrom('commerce_invoices').where('org_id', 'in', createdOrgs).execute();
      await sql`ALTER TABLE commerce_invoices ENABLE TRIGGER trg_commerce_invoices_issued_immutable`.execute(trx);
      await sql`ALTER TABLE commerce_invoice_lines ENABLE TRIGGER trg_commerce_invoice_lines_draft_only`.execute(trx);
    });
    await db.deleteFrom('commerce_billing_periods').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdUsers.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  await database.closeDb();
});

// ---------------------------------------------------------------------------------------------

describe('offline settlement', () => {
  it('an operator marks an issued invoice paid, once, with the attempt as evidence', async () => {
    const invoiceId = await invoiceFor(await org(), true);

    const paid = await request(app)
      .post(`/platform/billing/invoices/${invoiceId}/mark-paid`)
      .set('Authorization', bearer(operatorId))
      .send({ note: 'bank transfer ref 2026-08-0042' });
    expect(paid.status).toBe(200);
    expect(paid.body.data.invoice.status).toBe('paid');

    // Attested twice is still paid once — no second attempt row appears.
    const again = await request(app)
      .post(`/platform/billing/invoices/${invoiceId}/mark-paid`)
      .set('Authorization', bearer(operatorId))
      .send({ note: 'same transfer, second attestation' });
    expect(again.status).toBe(200);
    expect(again.body.data.invoice.status).toBe('paid');

    const attempts = await db
      .selectFrom('commerce_payment_attempts')
      .select(['provider', 'status'])
      .where('invoice_id', '=', invoiceId)
      .execute();
    expect(attempts).toEqual([{ provider: 'manual', status: 'succeeded' }]);
  });

  it('a draft cannot be marked paid — it has not finished claiming to be a bill', async () => {
    const invoiceId = await invoiceFor(await org(), false);
    const refused = await request(app)
      .post(`/platform/billing/invoices/${invoiceId}/mark-paid`)
      .set('Authorization', bearer(operatorId))
      .send({ note: 'eager' });
    expect(refused.status).toBe(400);
  });

  it('the charge surface refuses by name, and the webhook trusts nobody', async () => {
    const invoiceId = await invoiceFor(await org(), true);
    const error = await paymentService.chargeInvoice(invoiceId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error instanceof Error ? error.message : '').toBeTruthy();

    // No provider, no genuine deliveries: whatever POSTs here is refused.
    const webhook = await request(app)
      .post('/webhooks/payments')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } }));
    expect([400, 401]).toContain(webhook.status);
  });
});
