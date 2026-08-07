import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
// Type-only, so they are erased and do NOT load these modules before the environment below is set.
import type { db as dbType, closeDb as closeDbType } from '../database/index.js';

/**
 * THE SIXTY-DAY CLIFF.
 *
 * The Meta login configuration that grants the full WhatsApp management permission set issues a
 * token that dies sixty days after the client approves the dialog. Sixty days after a successful
 * onboarding is precisely when nobody is watching, so the failure this suite exists to prevent is a
 * business discovering — from its customers — that it has been unreachable.
 *
 * What is actually pinned here is the difference between three outcomes that a looser
 * implementation would collapse into one:
 *
 *  - Meta granted more time  → the new credential is stored and the old one destroyed.
 *  - Meta granted no time    → NOTHING is rotated, and the client keeps seeing the real deadline.
 *    "We tried" must never be able to look like "it is fixed".
 *  - The deadline has passed → the account is marked, in words, and can no longer send.
 *
 * Meta is a real HTTP server here that tracks a lifetime per token and answers `debug_token`
 * honestly, because a stand-in that always reported a fresh sixty days would make the middle case —
 * the one that decides whether a client is ever asked to reconnect — untestable.
 */

const APP_ID = '100000000000003';
const APP_HMAC = randomBytes(32).toString('hex');
const CONFIG_ID = '200000000000004';

const DAY_MS = 24 * 60 * 60 * 1000;

interface GraphCall {
  readonly method: string;
  readonly pathname: string;
  readonly query: Readonly<Record<string, string>>;
}

const graphCalls: GraphCall[] = [];
/** Anything the scripted Graph refused, with a reason — asserted empty after every test. */
const rejections: string[] = [];

/**
 * What Meta believes about each token it has issued: unix seconds, or 0 for one that never expires.
 *
 * A map rather than a single variable because the whole point of the renewal path is that the OLD
 * and NEW tokens have different deadlines, and the service is required to ask about the new one.
 */
const tokenExpiry = new Map<string, number>();

/** The lifetime the next Embedded Signup grant carries. */
let grantExpirySeconds = 0;
/** The lifetime the next `fb_exchange_token` renewal carries, or a refusal. */
let renewalExpiry: number | 'refuse' = 0;
let renewalCounter = 0;
/** The WABA the next authorization grants. */
let grantedWabaId = 'waba-default';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const graph: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const query = Object.fromEntries(url.searchParams.entries());
  const pathname = url.pathname.replace(/^\/v\d+\.\d+\//, '');
  graphCalls.push({ method: req.method ?? '', pathname, query });

  if (pathname === 'oauth/access_token') {
    if (query['client_id'] !== APP_ID || query['client_secret'] !== APP_HMAC) {
      rejections.push('graph: token call presented the wrong app credentials');
      json(res, 401, { error: { message: 'bad app credentials' } });
      return;
    }

    // The renewal. Meta's only non-interactive extension, and the one whose result must not be
    // assumed: it answers with a token, and says nothing here about how long that token lives.
    if (query['grant_type'] === 'fb_exchange_token') {
      const presented = query['fb_exchange_token'] ?? '';
      if (!tokenExpiry.has(presented)) {
        rejections.push(`graph: renewal presented a token Meta never issued (${presented})`);
        json(res, 400, { error: { message: 'unknown token' } });
        return;
      }
      if (renewalExpiry === 'refuse') {
        json(res, 400, { error: { message: 'Cannot exchange this token', code: 190 } });
        return;
      }
      renewalCounter += 1;
      const renewed = `renewed-token-${renewalCounter}`;
      tokenExpiry.set(renewed, renewalExpiry);
      json(res, 200, { access_token: renewed });
      return;
    }

    // The Embedded Signup code exchange.
    const issued = `biz-token-${query['code'] ?? ''}`;
    tokenExpiry.set(issued, grantExpirySeconds);
    json(res, 200, { access_token: issued });
    return;
  }

  if (pathname === 'debug_token') {
    const inspected = query['input_token'] ?? '';
    const expiresAt = tokenExpiry.get(inspected);
    if (expiresAt === undefined) {
      // Graph does not describe a token it never issued, and neither does this. Answering with a
      // made-up lifetime would let a bug that inspects the WRONG token pass silently.
      rejections.push(`graph: debug_token asked about a token Meta never issued (${inspected})`);
      json(res, 400, { error: { message: 'unknown token', code: 190 } });
      return;
    }
    json(res, 200, {
      data: {
        granular_scopes: [
          { scope: 'whatsapp_business_management', target_ids: [grantedWabaId] },
          { scope: 'business_management', target_ids: ['business-1'] },
        ],
        expires_at: expiresAt,
      },
    });
    return;
  }

  if (pathname.endsWith('/phone_numbers')) {
    json(res, 200, {
      data: [
        {
          id: 'phone-1',
          display_phone_number: '+1 555 010 0199',
          verified_name: 'Acme Coffee',
          quality_rating: 'GREEN',
          status: 'CONNECTED',
        },
      ],
    });
    return;
  }

  if (pathname.endsWith('/subscribed_apps')) {
    json(res, 200, { success: true });
    return;
  }

  json(res, 200, { id: pathname, name: 'Acme Coffee' });
});

await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
const graphOrigin = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;

process.env['META_COMMERCE_ENABLED'] = 'true';
process.env['META_COMMERCE_APP_ID'] = APP_ID;
process.env['META_COMMERCE_APP_SECRET'] = APP_HMAC;
process.env['META_COMMERCE_CONFIG_ID'] = CONFIG_ID;
process.env['META_COMMERCE_VERIFY_TOKEN'] = `verify-${randomBytes(8).toString('hex')}`;
process.env['META_COMMERCE_GRAPH_BASE_URL'] = graphOrigin;

const database = (await import('../database/index.js')) as {
  db: typeof dbType;
  closeDb: typeof closeDbType;
};
const { db } = database;
const { config } = await import('../config/unifiedConfig.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const orgRoutes = (await import('../commerce/routes/organizations.js')).default;
const { organizationRepository } = await import(
  '../commerce/repositories/organizationRepository.js'
);
const { channelAccountRepository } = await import(
  '../commerce/repositories/channelAccountRepository.js'
);
const { channelAccountService } = await import('../commerce/services/channelAccountService.js');
const { channelTokenService } = await import('../commerce/services/channelTokenService.js');
const { commerceWorker } = await import('../commerce/jobs/worker.js');
const { vault } = await import('../control-plane/vault/vault.js');

const app = express();
app.use(express.json());
app.use('/orgs', orgRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

interface Connected {
  readonly orgId: string;
  readonly accountId: string;
  readonly credentialRef: string;
  readonly expiresAt: string | null;
}

/** An organization with a WhatsApp account already connected, the way a real client arrives. */
async function connected(): Promise<Connected> {
  const user = await db
    .insertInto('users')
    .values({
      email: `commerce-expiry-${randomUUID()}@stewra.invalid`,
      display_name: 'Commerce Expiry Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(user.id);

  const { org } = await organizationRepository.create({
    name: 'Acme Coffee',
    slug: `acme-${randomUUID().slice(0, 8)}`,
    createdBy: user.id,
  });
  createdOrgs.push(org.id);

  const auth = `Bearer ${jwt.sign({ sub: user.id, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;

  const res = await request(API)
    .post(`/orgs/${org.id}/channels/whatsapp`)
    .set('Authorization', auth)
    .send({ code: `expiry-${randomUUID().slice(0, 8)}` });
  expect(res.status).toBe(201);

  const row = await rowFor(org.id);
  return {
    orgId: org.id,
    accountId: row.id,
    credentialRef: row.credential_ref,
    expiresAt: res.body.data.account.credentialExpiresAt,
  };
}

async function rowFor(orgId: string): Promise<{
  id: string;
  status: string;
  error_detail: string | null;
  credential_ref: string;
  credential_expires_at: Date | null;
}> {
  return db
    .selectFrom('channel_accounts')
    .select(['id', 'status', 'error_detail', 'credential_ref', 'credential_expires_at'])
    .where('org_id', '=', orgId)
    .executeTakeFirstOrThrow();
}

/** Move a connected account's deadline, standing in for the passage of time. */
async function setDeadline(accountId: string, at: Date): Promise<void> {
  await db
    .updateTable('channel_accounts')
    .set({ credential_expires_at: at })
    .where('id', '=', accountId)
    .execute();
}

/**
 * Run the worker until it finds nothing left to claim.
 *
 * Bounded rather than `while (true)`: a handler that kept re-queueing itself would otherwise hang the
 * suite with no indication of which job was responsible. Ten passes is far more than any test here
 * needs, so exhausting it means something is wrong and the assertion that follows should say so.
 */
async function drainJobs(): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    if ((await commerceWorker.runOnce()) === 0) return;
  }
  throw new Error('the commerce worker was still finding jobs after ten passes');
}

async function refresh(orgId: string, accountId: string): Promise<string> {
  const row = await channelAccountRepository.findForOrg(orgId, accountId);
  expect(row).not.toBeNull();
  return channelTokenService.refresh(row!);
}

beforeEach(() => {
  graphCalls.length = 0;
  rejections.length = 0;
  grantExpirySeconds = Math.floor((Date.now() + 60 * DAY_MS) / 1000);
  renewalExpiry = 0;
  grantedWabaId = `waba-${randomUUID().slice(0, 8)}`;
});

afterEach(() => {
  // The scripted Graph refused something we sent. Whatever the test was, THIS is the bug.
  expect(rejections).toEqual([]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => graph.close(() => resolve()));
  if (createdOrgs.length > 0) {
    await db.deleteFrom('channel_accounts').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_active_orgs').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdUsers.length > 0) {
    await db
      .deleteFrom('users')
      .where('id', 'in', createdUsers)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id')),
        ),
      )
      .execute();
  }
  await database.closeDb();
});

// ---------------------------------------------------------------------------------------------
// Knowing the deadline at all
// ---------------------------------------------------------------------------------------------

describe('what Meta says about the deadline', () => {
  it('records it at connect time, and publishes it to the client', async () => {
    const account = await connected();

    // Published, because the client is the only party who can fix an expiring grant — Meta requires
    // the business owner to approve the dialog again, and they cannot do that if nobody tells them.
    expect(account.expiresAt).not.toBeNull();
    const published = new Date(account.expiresAt!).getTime();
    expect(published).toBeCloseTo(grantExpirySeconds * 1000, -4);

    const row = await rowFor(account.orgId);
    expect(row.credential_expires_at?.getTime()).toBe(grantExpirySeconds * 1000);
  });

  it('records no deadline when Meta reports a credential that does not expire', async () => {
    // Meta says `expires_at: 0` for these. NULL is the honest translation — a date we invented here
    // would eventually mark a working channel broken for a deadline that never existed.
    grantExpirySeconds = 0;
    const account = await connected();

    expect(account.expiresAt).toBeNull();
    expect((await rowFor(account.orgId)).credential_expires_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Renewing while there is still time
// ---------------------------------------------------------------------------------------------

describe('renewing before the deadline', () => {
  it('stores the new credential and destroys the old one when Meta grants real time', async () => {
    const account = await connected();
    await setDeadline(account.accountId, new Date(Date.now() + 3 * DAY_MS));
    renewalExpiry = Math.floor((Date.now() + 60 * DAY_MS) / 1000);

    expect(await refresh(account.orgId, account.accountId)).toBe('extended');

    const row = await rowFor(account.orgId);
    expect(row.status).toBe('active');
    expect(row.credential_ref).not.toBe(account.credentialRef);
    expect(row.credential_expires_at?.getTime()).toBe(renewalExpiry * 1000);
    // The vault holds the token Meta just issued, and no longer holds the one it replaced. A
    // superseded WhatsApp credential left at rest is a live credential nobody is tracking.
    expect(await vault.get(row.credential_ref)).toBe(`renewed-token-${renewalCounter}`);
    await expect(vault.get(account.credentialRef)).rejects.toThrow(/no secret for ref/);
  });

  it('changes NOTHING when the exchange buys no additional time', async () => {
    const account = await connected();
    const deadline = new Date(Date.now() + 3 * DAY_MS);
    await setDeadline(account.accountId, deadline);
    // Meta hands back a token — but one that dies at the same moment as the old one.
    renewalExpiry = Math.floor(deadline.getTime() / 1000);

    expect(await refresh(account.orgId, account.accountId)).toBe('not-extended');

    const row = await rowFor(account.orgId);
    // The client keeps seeing the REAL deadline, so "we tried" cannot be mistaken for "it is fixed".
    expect(row.credential_expires_at?.getTime()).toBe(deadline.getTime());
    expect(row.credential_ref).toBe(account.credentialRef);
    // And the channel keeps working right up to the deadline. A token approaching expiry is not a
    // broken token, and telling a business to stop early costs them real conversations.
    expect(row.status).toBe('active');
    await expect(
      channelAccountService.resolve((await channelAccountRepository.findForOrg(
        account.orgId,
        account.accountId,
      ))!),
    ).resolves.toBeDefined();
  });

  it('leaves the working credential alone when Meta refuses the exchange outright', async () => {
    const account = await connected();
    const deadline = new Date(Date.now() + 3 * DAY_MS);
    await setDeadline(account.accountId, deadline);
    renewalExpiry = 'refuse';

    expect(await refresh(account.orgId, account.accountId)).toBe('failed');

    const row = await rowFor(account.orgId);
    // A refused renewal is not a broken channel — the existing token is valid for three more days,
    // and the next hourly pass will try again.
    expect(row.status).toBe('active');
    expect(row.credential_ref).toBe(account.credentialRef);
    expect(row.credential_expires_at?.getTime()).toBe(deadline.getTime());
  });

  it('is what the hourly sweep and the worker actually do, together', async () => {
    const account = await connected();
    await setDeadline(account.accountId, new Date(Date.now() + 3 * DAY_MS));
    renewalExpiry = Math.floor((Date.now() + 60 * DAY_MS) / 1000);

    // The two halves of the real path: the timer decides what is due and puts it on the queue, the
    // worker drains it. Driven separately here rather than through `setInterval`, because a queue
    // whose retry behaviour can only be observed by waiting a real five seconds is a queue whose
    // retry behaviour does not get tested.
    const enqueued = await channelTokenService.enqueueDueRefreshes();
    expect(enqueued).toBeGreaterThanOrEqual(1);
    await drainJobs();

    const row = await rowFor(account.orgId);
    expect(row.credential_ref).not.toBe(account.credentialRef);
    expect(row.credential_expires_at?.getTime()).toBe(renewalExpiry * 1000);
  });

  it('does not touch an account whose deadline is still far away', async () => {
    const account = await connected();
    await setDeadline(account.accountId, new Date(Date.now() + 45 * DAY_MS));

    await channelTokenService.enqueueDueRefreshes();
    await drainJobs();

    // Renewing 45 days early would spend a Graph call on every account every hour, and — because a
    // renewal rotates the vaulted secret — churn a credential that has nothing wrong with it.
    expect(graphCalls.filter((c) => c.query['grant_type'] === 'fb_exchange_token')).toHaveLength(0);
    expect((await rowFor(account.orgId)).credential_ref).toBe(account.credentialRef);
  });
});

// ---------------------------------------------------------------------------------------------
// After the deadline
// ---------------------------------------------------------------------------------------------

describe('once the credential has expired', () => {
  it('marks the account for reconnect in words, and stops it sending', async () => {
    const account = await connected();
    await setDeadline(account.accountId, new Date(Date.now() - DAY_MS));

    expect(await refresh(account.orgId, account.accountId)).toBe('expired');

    const row = await rowFor(account.orgId);
    expect(row.status).toBe('error');
    // Not a code. This string is what a business owner reads, and it has to tell them both what
    // happened and that only they can fix it.
    expect(row.error_detail).toContain('expired on');
    expect(row.error_detail).toContain('Reconnect the account');
    expect(row.error_detail).toContain('business owner');

    // Nothing was even attempted at Meta: a dead token cannot be exchanged, and asking would only
    // turn one failure into two.
    expect(graphCalls.filter((c) => c.query['grant_type'] === 'fb_exchange_token')).toHaveLength(0);

    // resolve() is the only door to a sender, and it now refuses.
    const stored = await channelAccountRepository.findForOrg(account.orgId, account.accountId);
    await expect(channelAccountService.resolve(stored!)).rejects.toThrow(/reconnect it to send/i);
  });

  it('says it once, not once an hour', async () => {
    const account = await connected();
    await setDeadline(account.accountId, new Date(Date.now() - DAY_MS));
    expect(await refresh(account.orgId, account.accountId)).toBe('expired');
    const first = await rowFor(account.orgId);

    expect(await refresh(account.orgId, account.accountId)).toBe('expired');

    // Same row, same wording. Rewriting it every pass would churn the row and, on a surface that
    // shows "last changed", would keep re-announcing a fault the client already knows about.
    const second = await rowFor(account.orgId);
    expect(second.error_detail).toBe(first.error_detail);
  });
});

// ---------------------------------------------------------------------------------------------
// The credential we cannot read
// ---------------------------------------------------------------------------------------------

describe('when the stored credential has gone missing', () => {
  it('says so instead of pretending the channel is fine', async () => {
    const account = await connected();
    await setDeadline(account.accountId, new Date(Date.now() + 3 * DAY_MS));
    await vault.delete(account.credentialRef);

    expect(await refresh(account.orgId, account.accountId)).toBe('failed');

    const row = await rowFor(account.orgId);
    expect(row.status).toBe('error');
    // The same sentence `channelAccountService.resolve` uses, so a client sees one explanation for
    // one fault rather than two competing ones.
    expect(row.error_detail).toContain('missing or unreadable');
  });
});
