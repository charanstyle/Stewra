import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';

/**
 * THE STRIPE HALF of the payment seam (migration 055 + the port): charges through a scripted
 * Stripe stand-in, and the webhook that finishes pending ones.
 *
 * The properties pinned: the idempotency key travels on the wire and two racing collectors cannot
 * both claim it; a charge without a stored payment method fails BEFORE any wire call; a declined
 * charge leaves the invoice issued and retryable; a pending charge is completed only by a
 * webhook whose signature verifies against the raw bytes, and replays change nothing.
 */

/** What the scripted Stripe does with the next payment_intents call. */
let intentMode: 'succeed' | 'pending' | 'decline' = 'succeed';
/** Every request the stand-in served: path, idempotency key, form body. */
const stripeCalls: Array<{ path: string; idempotencyKey: string | null; body: string }> = [];

const WEBHOOK_SECRET = `whsec_${randomBytes(16).toString('hex')}`;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const stripe: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8');
  });
  req.on('end', () => {
    const path = req.url ?? '/';
    const keyHeader = req.headers['idempotency-key'];
    stripeCalls.push({
      path,
      idempotencyKey: typeof keyHeader === 'string' ? keyHeader : null,
      body: raw,
    });
    if (path === '/v1/customers') {
      json(res, 200, { id: `cus_${randomUUID().slice(0, 8)}` });
      return;
    }
    if (path === '/v1/setup_intents') {
      json(res, 200, { client_secret: `seti_secret_${randomUUID().slice(0, 8)}` });
      return;
    }
    if (path === '/v1/payment_intents') {
      if (intentMode === 'decline') {
        json(res, 402, { error: { message: 'Your card was declined.', type: 'card_error' } });
        return;
      }
      json(res, 200, {
        id: `pi_${randomUUID().slice(0, 12)}`,
        status: intentMode === 'succeed' ? 'succeeded' : 'processing',
      });
      return;
    }
    json(res, 404, { error: { message: `unscripted stripe path: ${path}` } });
  });
});

await new Promise<void>((resolve) => stripe.listen(0, '127.0.0.1', resolve));
const stripeOrigin = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;

process.env['META_COMMERCE_ENABLED'] = 'true';
process.env['META_COMMERCE_APP_ID'] = '100000000000001';
process.env['META_COMMERCE_APP_SECRET'] = randomBytes(32).toString('hex');
process.env['META_COMMERCE_CONFIG_ID'] = '200000000000002';
process.env['META_COMMERCE_VERIFY_TOKEN'] = `verify-${randomBytes(8).toString('hex')}`;
process.env['META_COMMERCE_GRAPH_BASE_URL'] = 'http://127.0.0.1:9';
process.env['COMMERCE_BILLING_PROVIDER'] = 'stripe';
process.env['STRIPE_SECRET_KEY'] = `sk_test_${randomBytes(16).toString('hex')}`;
process.env['STRIPE_WEBHOOK_SECRET'] = WEBHOOK_SECRET;
// Required at boot alongside the other two: the billing page cannot capture a card without it, so
// a Stripe deploy missing it is broken in a way that only shows up in front of a customer.
process.env['STRIPE_PUBLISHABLE_KEY'] = `pk_test_${randomBytes(16).toString('hex')}`;
process.env['STRIPE_API_BASE_URL'] = stripeOrigin;

const database = (await import('../database/index.js')) as {
  db: typeof dbType;
  closeDb: typeof closeDbType;
};
const { db } = database;
const { config } = await import('../config/unifiedConfig.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const orgRoutes = (await import('../tenancy/routes/organizations.js')).default;
const commerceOrgRoutes = (await import('../commerce/routes/orgSurface.js')).default;
const billingRoutes = (await import('../commerce/routes/billing.js')).default;
const paymentsWebhookRoutes = (await import('../commerce/routes/paymentsWebhook.js')).default;
const { organizationRepository } = await import(
  '../tenancy/repositories/organizationRepository.js'
);
const { invoiceRepository } = await import('../commerce/repositories/invoiceRepository.js');
const { billingCustomerRepository } = await import(
  '../commerce/repositories/billingCustomerRepository.js'
);
const { paymentService } = await import('../commerce/services/paymentService.js');
const { stripeAmount } = await import('../commerce/services/payments/stripeProvider.js');
const { ValidationError } = await import('../utils/errors.js');

const app = express();
// Raw-body webhook BEFORE express.json, mirroring app.ts — the signature is over exact bytes.
app.use('/webhooks/payments', paymentsWebhookRoutes);
app.use(express.json());
app.use('/orgs', orgRoutes);
app.use('/orgs/:orgId', commerceOrgRoutes);
app.use('/platform/billing', billingRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdOrgs: string[] = [];
const createdUsers: string[] = [];

const CUR = `Z${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]}`;
/** One invoice's total in this suite — a clean multiple of the two-decimal wire unit. */
const TOTAL = 250_000n;

// Fourth address in the test INSTALL_ADMIN_EMAILS list; each billing-adjacent suite owns one so
// parallel runs never race to create the same unique email.
const OPERATOR_EMAIL = 'payments-admin@stewra.test';

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
      display_name: 'Payments Tester',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

async function tenant(): Promise<{ orgId: string; userId: string; auth: string }> {
  const userId = await createUser(`payments-${randomUUID()}@stewra.invalid`);
  const { org } = await organizationRepository.create({
    kind: 'business',
    name: 'Payments Test Org',
    slug: `payments-${randomUUID().slice(0, 12)}`,
    createdBy: userId,
  });
  createdOrgs.push(org.id);
  return { orgId: org.id, userId, auth: bearer(userId) };
}

/** One issued invoice, written through the same close writer production uses. */
async function issuedInvoice(orgId: string): Promise<string> {
  const invoice = await invoiceRepository.writeCloseOutcome({
    orgId,
    currency: CUR,
    periodStart: LAST_MONTH,
    periodEnd: THIS_MONTH,
    lines: [
      { kind: 'message_costs', description: 'test pass-through', quantity: 1, amountMicros: TOTAL },
    ],
    unratedBillable: 0,
    unpricedMessages: 0,
    issue: true,
  });
  return invoice.id;
}

/** A Stripe-Signature header that verifies for `payload` under this suite's webhook secret. */
function signedHeader(payload: string, secret = WEBHOOK_SECRET): string {
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

async function attemptsOf(invoiceId: string): Promise<
  Array<{ status: string; provider_ref: string | null; error: string | null; idempotency_key: string }>
> {
  return db
    .selectFrom('commerce_payment_attempts')
    .select(['status', 'provider_ref', 'error', 'idempotency_key'])
    .where('invoice_id', '=', invoiceId)
    .orderBy('created_at')
    .execute();
}

async function statusOf(invoiceId: string): Promise<string> {
  const row = await db
    .selectFrom('commerce_invoices')
    .select('status')
    .where('id', '=', invoiceId)
    .executeTakeFirstOrThrow();
  return row.status;
}

/**
 * The webhook controller is deliberately ACK-then-work: the 200 is on the wire BEFORE `applyEvent`
 * touches the database. So "the genuine delivery pays the invoice" is eventually true, not
 * synchronously true after the request resolves — asserting `statusOf` immediately races the apply
 * and loses on a slow runner (it did, in CI). Poll briefly; on timeout return whatever is stored so
 * the assertion still fails with the real status in the message.
 */
async function waitForStatus(invoiceId: string, expected: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = await statusOf(invoiceId);
    if (status === expected || Date.now() > deadline) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let operatorId = '';

beforeAll(async () => {
  operatorId = await createUser(OPERATOR_EMAIL);
  if (!config.installAdmins.includes(OPERATOR_EMAIL)) {
    throw new Error(
      `INSTALL_ADMIN_EMAILS must include ${OPERATOR_EMAIL} for this suite (fix backend/.env.test and ci.yml)`,
    );
  }
});

beforeEach(() => {
  intentMode = 'succeed';
  stripeCalls.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => stripe.close(() => resolve()));
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
    await db.deleteFrom('commerce_billing_customers').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdUsers.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  await database.closeDb();
});

// ---------------------------------------------------------------------------------------------

describe('the wire unit', () => {
  it('converts micros exactly or refuses — an invoice amount is never rounded', () => {
    expect(stripeAmount(250_000n, CUR)).toBe(25n); // two-decimal: micros / 10_000
    expect(stripeAmount(1_000_000n, 'JPY')).toBe(1n); // zero-decimal: micros / 1_000_000
    expect(() => stripeAmount(5_000n, CUR)).toThrow(ValidationError);
    expect(() => stripeAmount(500_000n, 'JPY')).toThrow(ValidationError);
  });
});

describe('charging', () => {
  it('refuses before the wire without a stored method, then charges once one exists', async () => {
    const t = await tenant();
    const invoiceId = await issuedInvoice(t.orgId);

    // No stored payment method: the failure is local — Stripe never sees a payment_intents call.
    const first = await paymentService.chargeInvoice(invoiceId);
    expect(first.attempt.status).toBe('failed');
    expect(first.attempt.error).toContain('no stored payment method');
    expect(stripeCalls.filter((c) => c.path === '/v1/payment_intents')).toHaveLength(0);
    expect(await statusOf(invoiceId)).toBe('issued');
    // The customer WAS created — the setup flow needs it to exist.
    expect(stripeCalls.filter((c) => c.path === '/v1/customers')).toHaveLength(1);

    // The client completes the provider's setup flow (simulated); the retry collects.
    await billingCustomerRepository.savePaymentMethodRef({
      orgId: t.orgId,
      provider: 'stripe',
      paymentMethodRef: 'pm_stored',
    });
    const second = await paymentService.chargeInvoice(invoiceId);
    expect(second.attempt.status).toBe('succeeded');
    expect(second.attempt.providerRef).toMatch(/^pi_/);
    expect(second.invoice.status).toBe('paid');
    expect(await statusOf(invoiceId)).toBe('paid');

    // The idempotency chain's wire link: the numbered key traveled on the header, and the
    // existing customer was reused rather than recreated.
    const intents = stripeCalls.filter((c) => c.path === '/v1/payment_intents');
    expect(intents).toHaveLength(1);
    expect(intents[0]?.idempotencyKey).toBe(`invoice-${invoiceId}-2`);
    expect(stripeCalls.filter((c) => c.path === '/v1/customers')).toHaveLength(1);
    expect(intents[0]?.body).toContain('amount=25');
  });

  it('a declined charge records the provider’s words and leaves the invoice collectible', async () => {
    const t = await tenant();
    const invoiceId = await issuedInvoice(t.orgId);
    await billingCustomerRepository.saveCustomerRef({
      orgId: t.orgId,
      provider: 'stripe',
      customerRef: 'cus_prewired',
    });
    await billingCustomerRepository.savePaymentMethodRef({
      orgId: t.orgId,
      provider: 'stripe',
      paymentMethodRef: 'pm_declines',
    });

    intentMode = 'decline';
    const result = await paymentService.chargeInvoice(invoiceId);
    expect(result.attempt.status).toBe('failed');
    expect(result.attempt.error).toBe('Your card was declined.');
    expect(await statusOf(invoiceId)).toBe('issued');

    // Retry is a NEW attempt with a NEW key — the declined one is history, not a lock.
    intentMode = 'succeed';
    const retry = await paymentService.chargeInvoice(invoiceId);
    expect(retry.attempt.status).toBe('succeeded');
    expect(await statusOf(invoiceId)).toBe('paid');
    const attempts = await attemptsOf(invoiceId);
    expect(attempts.map((a) => a.status)).toEqual(['failed', 'succeeded']);
    expect(new Set(attempts.map((a) => a.idempotency_key)).size).toBe(2);
  });

  it('a pending charge is finished by the signed webhook, and a replay changes nothing', async () => {
    const t = await tenant();
    const invoiceId = await issuedInvoice(t.orgId);
    await billingCustomerRepository.saveCustomerRef({
      orgId: t.orgId,
      provider: 'stripe',
      customerRef: 'cus_pending',
    });
    await billingCustomerRepository.savePaymentMethodRef({
      orgId: t.orgId,
      provider: 'stripe',
      paymentMethodRef: 'pm_slow',
    });

    intentMode = 'pending';
    const result = await paymentService.chargeInvoice(invoiceId);
    expect(result.attempt.status).toBe('pending');
    const providerRef = result.attempt.providerRef ?? '';
    expect(providerRef).toMatch(/^pi_/);
    expect(await statusOf(invoiceId)).toBe('issued');

    // A forged delivery — wrong secret — is refused and settles nothing.
    const payload = JSON.stringify({
      type: 'payment_intent.succeeded',
      data: { object: { id: providerRef } },
    });
    const forged = await request(app)
      .post('/webhooks/payments')
      .set('content-type', 'application/json')
      .set('stripe-signature', signedHeader(payload, `whsec_${randomBytes(16).toString('hex')}`))
      .send(payload);
    expect(forged.status).toBe(401);
    expect(await statusOf(invoiceId)).toBe('issued');

    // The genuine article settles the attempt and pays the invoice.
    const genuine = await request(app)
      .post('/webhooks/payments')
      .set('content-type', 'application/json')
      .set('stripe-signature', signedHeader(payload))
      .send(payload);
    expect(genuine.status).toBe(200);
    expect(await waitForStatus(invoiceId, 'paid')).toBe('paid');
    expect((await attemptsOf(invoiceId)).map((a) => a.status)).toEqual(['succeeded']);

    // Stripe retries webhooks for days; the replay finds nothing pending and changes nothing.
    const replay = await request(app)
      .post('/webhooks/payments')
      .set('content-type', 'application/json')
      .set('stripe-signature', signedHeader(payload))
      .send(payload);
    expect(replay.status).toBe(200);
    expect((await attemptsOf(invoiceId)).map((a) => a.status)).toEqual(['succeeded']);

    // The org reads the whole story on its own invoice.
    const detail = await request(app)
      .get(`/orgs/${t.orgId}/invoices/${invoiceId}`)
      .set('Authorization', t.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.invoice.status).toBe('paid');
    expect(detail.body.data.attempts).toHaveLength(1);
    expect(detail.body.data.attempts[0]).toMatchObject({ status: 'succeeded', provider: 'stripe' });
  });

  it('the platform charge surface does not exist for org users', async () => {
    const t = await tenant();
    const invoiceId = await issuedInvoice(t.orgId);
    const charge = await request(app)
      .post(`/platform/billing/invoices/${invoiceId}/charge`)
      .set('Authorization', t.auth)
      .send({});
    expect(charge.status).toBe(404);

    // And the operator surface is real: the same call from the operator collects.
    await billingCustomerRepository.saveCustomerRef({
      orgId: t.orgId,
      provider: 'stripe',
      customerRef: 'cus_operator',
    });
    await billingCustomerRepository.savePaymentMethodRef({
      orgId: t.orgId,
      provider: 'stripe',
      paymentMethodRef: 'pm_operator',
    });
    const collected = await request(app)
      .post(`/platform/billing/invoices/${invoiceId}/charge`)
      .set('Authorization', bearer(operatorId))
      .send({});
    expect(collected.status).toBe(200);
    expect(collected.body.data.invoice.status).toBe('paid');
  });
});
