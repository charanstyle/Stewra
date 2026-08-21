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
 * Connecting a client's OWN WhatsApp number — Embedded Signup, end to end, with nothing stubbed on
 * our side of the wire.
 *
 * The subject is the REGISTRATION step, which is the one that decides whether a connected channel
 * can actually send. Meta's contract there is awkward in a way that matters: a number that is not
 * yet registered needs its six-digit two-step verification PIN, a number already registered needs
 * none, and a wrong PIN counts against a lockout that lasts hours. So the behaviour worth pinning is
 * not "does it call register" but *when* it asks for a PIN, what it does with a rejection, and what
 * state the client is left in either way.
 *
 * Meta is a real HTTP server here, implementing the flow faithfully — it checks the app credentials
 * on the exchange, reports a phone number status, and rejects a wrong PIN the way Graph does. A
 * stand-in that said yes to everything would let all four of those behaviours regress unnoticed.
 */

const APP_ID = '100000000000001';
const APP_HMAC = randomBytes(32).toString('hex');
const CONFIG_ID = '200000000000002';
const CORRECT_PIN = '246810';

interface GraphCall {
  readonly method: string;
  readonly pathname: string;
  readonly query: Readonly<Record<string, string>>;
}

/** Every request the scripted Graph received, so "register was never called" is checkable. */
const graphCalls: GraphCall[] = [];
/** Anything the scripted Graph refused, with a reason — asserted empty after every test. */
const rejections: string[] = [];

/** The phone number status Meta will report next. Drives whether a PIN is required. */
let phoneStatus = 'CONNECTED';
/** The WABA the next authorization grants. */
let grantedWabaId = 'waba-default';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * A real HTTP server playing Meta's Graph host. `META_COMMERCE_GRAPH_BASE_URL` points at it, so the
 * service makes real `fetch` calls over a real socket — nothing patches `globalThis.fetch`.
 */
const graph: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const query = Object.fromEntries(url.searchParams.entries());
  // Strip the pinned Graph version prefix so the cases below read as the endpoints they are.
  const pathname = url.pathname.replace(/^\/v\d+\.\d+\//, '');
  graphCalls.push({ method: req.method ?? '', pathname, query });

  if (pathname === 'oauth/access_token') {
    if (query['client_id'] !== APP_ID || query['client_secret'] !== APP_HMAC) {
      rejections.push('graph: code exchange presented the wrong app credentials');
      json(res, 401, { error: { message: 'bad app credentials' } });
      return;
    }
    json(res, 200, { access_token: `biz-token-${query['code'] ?? ''}` });
    return;
  }

  if (pathname === 'debug_token') {
    json(res, 200, {
      data: {
        granular_scopes: [
          { scope: 'whatsapp_business_management', target_ids: [grantedWabaId] },
          { scope: 'business_management', target_ids: ['business-1'] },
        ],
      },
    });
    return;
  }

  if (pathname.endsWith('/phone_numbers')) {
    json(res, 200, {
      data: [
        {
          id: 'phone-1',
          display_phone_number: '+1 555 010 0100',
          verified_name: 'Acme Coffee',
          quality_rating: 'GREEN',
          status: phoneStatus,
        },
      ],
    });
    return;
  }

  if (pathname.endsWith('/subscribed_apps')) {
    json(res, 200, { success: true });
    return;
  }

  if (pathname.endsWith('/register')) {
    if (query['pin'] !== CORRECT_PIN) {
      // Graph's real shape for this, near enough that the message the client sees is realistic.
      json(res, 400, {
        error: { message: 'Two-step verification PIN mismatch', code: 133005 },
      });
      return;
    }
    json(res, 200, { success: true });
    return;
  }

  // A bare `GET /{waba-id}` — the display metadata read.
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
const orgRoutes = (await import('../tenancy/routes/organizations.js')).default;
const commerceOrgRoutes = (await import('../commerce/routes/orgSurface.js')).default;
const { organizationRepository } = await import(
  '../tenancy/repositories/organizationRepository.js'
);
const { vault } = await import('../control-plane/vault/vault.js');

const app = express();
app.use(express.json());
app.use('/orgs', orgRoutes);
app.use('/orgs/:orgId', commerceOrgRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

interface Tenant {
  readonly orgId: string;
  readonly auth: string;
}

async function tenant(role: 'owner' | 'viewer' = 'owner'): Promise<Tenant> {
  const user = await db
    .insertInto('users')
    .values({
      email: `commerce-connect-${randomUUID()}@stewra.invalid`,
      display_name: 'Commerce Connect Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(user.id);

  const { org } = await organizationRepository.create({
    kind: 'business',
    name: 'Acme Coffee',
    slug: `acme-${randomUUID().slice(0, 8)}`,
    createdBy: user.id,
  });
  createdOrgs.push(org.id);

  if (role !== 'owner') {
    await db
      .updateTable('org_members')
      .set({ role })
      .where('org_id', '=', org.id)
      .where('user_id', '=', user.id)
      .execute();
  }

  const auth = `Bearer ${jwt.sign({ sub: user.id, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
  return { orgId: org.id, auth };
}

async function accountRow(orgId: string): Promise<{
  id: string;
  status: string;
  error_detail: string | null;
  credential_ref: string;
  phone_number_id: string | null;
} | null> {
  const row = await db
    .selectFrom('channel_accounts')
    .select(['id', 'status', 'error_detail', 'credential_ref', 'phone_number_id'])
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  return row ?? null;
}

function registerCalls(): GraphCall[] {
  return graphCalls.filter((c) => c.pathname.endsWith('/register'));
}

beforeEach(() => {
  graphCalls.length = 0;
  rejections.length = 0;
  phoneStatus = 'CONNECTED';
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
        not(exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id'))),
      )
      .execute();
  }
  await database.closeDb();
});

// ---------------------------------------------------------------------------------------------
// When a PIN is asked for, and when it is not
// ---------------------------------------------------------------------------------------------

describe('registering the number for sending', () => {
  it('connects a number Meta already reports as CONNECTED without asking for a PIN', async () => {
    const { orgId, auth } = await tenant();
    phoneStatus = 'CONNECTED';

    const res = await request(API)
      .post(`/orgs/${orgId}/channels/whatsapp`)
      .set('Authorization', auth)
      .send({ code: 'auth-code-1' });

    expect(res.status).toBe(201);
    expect(res.body.data.account.status).toBe('active');
    // Asking for a PIN here would block every reconnect behind a secret the client may not still have.
    expect(registerCalls()).toHaveLength(0);
  });

  it('refuses a number that needs registering when no PIN was given — and writes NOTHING', async () => {
    const { orgId, auth } = await tenant();
    phoneStatus = 'PENDING';

    const res = await request(API)
      .post(`/orgs/${orgId}/channels/whatsapp`)
      .set('Authorization', auth)
      .send({ code: 'auth-code-2' });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('pin');

    // Refused BEFORE anything irreversible: no row, and the app was never subscribed to their
    // webhooks. A client who simply does not have the PIN to hand loses nothing.
    expect(await accountRow(orgId)).toBeNull();
    expect(graphCalls.filter((c) => c.pathname.endsWith('/subscribed_apps'))).toHaveLength(0);
  });

  it('registers with the PIN it was given, and stores an active channel', async () => {
    const { orgId, auth } = await tenant();
    phoneStatus = 'PENDING';

    const res = await request(API)
      .post(`/orgs/${orgId}/channels/whatsapp`)
      .set('Authorization', auth)
      .send({ code: 'auth-code-3', pin: CORRECT_PIN });

    expect(res.status).toBe(201);
    expect(res.body.data.account.status).toBe('active');

    const calls = registerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe('phone-1/register');
    expect(calls[0]?.query['messaging_product']).toBe('whatsapp');

    const row = await accountRow(orgId);
    expect(row?.status).toBe('active');
    expect(row?.phone_number_id).toBe('phone-1');
  });

  it('rejects a malformed PIN before it reaches Meta — a wrong attempt costs hours of lockout', async () => {
    const { orgId, auth } = await tenant();
    phoneStatus = 'PENDING';

    const res = await request(API)
      .post(`/orgs/${orgId}/channels/whatsapp`)
      .set('Authorization', auth)
      .send({ code: 'auth-code-4', pin: '12ab' });

    expect(res.status).toBe(400);
    // Same `pin` field as the other two refusals, so the connect UI keeps showing the PIN box rather
    // than treating a typo as an unrelated failure.
    expect(res.body.error.details[0].field).toBe('pin');
    // Never sent. Meta locks two-step verification after a few bad attempts, so a PIN we can already
    // see is malformed must not be spent on finding that out.
    expect(registerCalls()).toHaveLength(0);
    expect(await accountRow(orgId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// A rejected PIN is recoverable, not a rollback
// ---------------------------------------------------------------------------------------------

describe('when Meta rejects the PIN', () => {
  it('keeps the channel, marks it error, and says why in Meta’s own words', async () => {
    const { orgId, auth } = await tenant();
    phoneStatus = 'PENDING';

    const res = await request(API)
      .post(`/orgs/${orgId}/channels/whatsapp`)
      .set('Authorization', auth)
      .send({ code: 'auth-code-5', pin: '000000' });

    expect(res.status).toBe(400);
    // Named as a PIN problem, not just "something failed": the connect UI reads this field to decide
    // whether to ask for a PIN, so the name is a contract and not an implementation detail.
    expect(res.body.error.details[0].field).toBe('pin');

    // The row SURVIVES. Inbound keeps arriving — the business still sees its customers — and the fix
    // is connecting again with the right PIN. That does mean walking Meta's dialog a second time,
    // because the authorization code was already spent on the token exchange before the PIN was
    // ever tried, and Meta's codes are single-use.
    const row = await accountRow(orgId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('error');
    expect(row?.error_detail).toContain('not registered for sending');
    // Meta's actual reason is carried through, not replaced with something generic.
    expect(row?.error_detail).toContain('PIN mismatch');
  });

  it('leaves that channel unable to send, so nothing goes out from a half-connected number', async () => {
    const { orgId, auth } = await tenant();
    phoneStatus = 'PENDING';
    await request(API)
      .post(`/orgs/${orgId}/channels/whatsapp`)
      .set('Authorization', auth)
      .send({ code: 'auth-code-6', pin: '000000' });

    const row = await accountRow(orgId);
    expect(row?.status).toBe('error');

    const { channelAccountService } = await import('../commerce/services/channelAccountService.js');
    const { channelAccountRepository } = await import(
      '../commerce/repositories/channelAccountRepository.js'
    );
    const stored = await channelAccountRepository.findForOrg(orgId, row?.id ?? '');
    expect(stored).not.toBeNull();
    // resolve() is the only door to a sender, and it refuses a non-active account by design.
    await expect(channelAccountService.resolve(stored!)).rejects.toThrow(/reconnect it to send/i);
  });
});

// ---------------------------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------------------------

describe('the business token', () => {
  it('is vaulted and never returned to the client', async () => {
    const { orgId, auth } = await tenant();

    const res = await request(API)
      .post(`/orgs/${orgId}/channels/whatsapp`)
      .set('Authorization', auth)
      .send({ code: 'auth-code-7' });
    expect(res.status).toBe(201);

    // The API shape has no field for it at all — that is what makes leaking one impossible rather
    // than merely unlikely.
    expect(JSON.stringify(res.body)).not.toContain('biz-token');

    const row = await accountRow(orgId);
    expect(row?.credential_ref).not.toContain('biz-token');
    // The ref really does resolve to the token, so it was stored rather than discarded.
    expect(await vault.get(row?.credential_ref ?? '')).toBe('biz-token-auth-code-7');
  });

  it('refuses to move a WABA that another organization already connected', async () => {
    const first = await tenant();
    const second = await tenant();
    const shared = grantedWabaId;

    expect(
      (
        await request(API)
          .post(`/orgs/${first.orgId}/channels/whatsapp`)
          .set('Authorization', first.auth)
          .send({ code: 'auth-code-8' })
      ).status,
    ).toBe(201);

    grantedWabaId = shared;
    const res = await request(API)
      .post(`/orgs/${second.orgId}/channels/whatsapp`)
      .set('Authorization', second.auth)
      .send({ code: 'auth-code-9' });

    // Silently moving it would hand one business another's inbox. This needs a human.
    expect(res.status).toBe(409);
    expect(await accountRow(second.orgId)).toBeNull();
  });

  it('will not let a viewer connect a channel', async () => {
    const { orgId, auth } = await tenant('viewer');

    const res = await request(API)
      .post(`/orgs/${orgId}/channels/whatsapp`)
      .set('Authorization', auth)
      .send({ code: 'auth-code-10' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_ORG_ROLE');
    expect(graphCalls).toHaveLength(0);
  });
});
