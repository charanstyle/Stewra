import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, it, expect, afterAll } from 'vitest';

/**
 * THE MONEY MILESTONE, end to end against a scripted Plaid: Link start → public-token exchange →
 * the access token into the vault and the first sync into the store → derived facts through the
 * broker → incremental cursor sync → terminal grant loss revoking the connection → disconnect
 * severing the Item at Plaid and purging the store.
 *
 * The properties pinned are the containment ones: the access token never leaves the vault, merchant
 * text is encrypted at rest, only short fact strings cross the broker (no ids, no tokens, no raw
 * records), and a user with no bank connection is DENIED money facts by policy rather than handed
 * an empty success.
 *
 * Real Postgres, the real routes and middleware over real HTTP, and a real node:http Plaid stand-in
 * — the same shape as the Stripe/Graph stand-ins in the commerce suites.
 *
 * ⚠️ This suite deliberately does NOT delete its users: connect/sync/disconnect write audit rows,
 * and `audit_log.user_id` is ON DELETE SET NULL, which the append-only trigger rejects (the same
 * interaction emailProposalGate.test.ts records). Connections are deleted (cascading the money
 * store) and vault secrets are purged by collected ref.
 */

const ITEM_ID = 'item-stand-in-A';
const ACCESS_TOKEN = `access-sandbox-${randomBytes(12).toString('hex')}`;
const LINK_TOKEN = 'link-sandbox-stand-in';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
function daysAgo(days: number): string {
  const d = new Date(Date.now() - days * MS_PER_DAY);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

interface StandInTransaction {
  readonly transaction_id: string;
  readonly account_id: string;
  readonly name: string;
  readonly merchant_name: string | null;
  readonly personal_finance_category: { readonly primary: string } | null;
  readonly amount: number;
  readonly iso_currency_code: string;
  readonly date: string;
  readonly pending: boolean;
}

function txn(
  id: string,
  merchant: string,
  amount: number,
  date: string,
  pending = false,
): StandInTransaction {
  return {
    transaction_id: id,
    account_id: 'acct-checking',
    name: `${merchant.toUpperCase()} POS DEBIT`,
    merchant_name: merchant,
    personal_finance_category: { primary: 'GENERAL_MERCHANDISE' },
    amount,
    iso_currency_code: 'USD',
    date,
    pending,
  };
}

// Older-than-a-week history (page 1): a monthly Streamly and routine Grocer charges (median 90).
const PAGE_ONE = [
  txn('plaid-txn-streamly-1', 'Streamly', 12.99, daysAgo(65)),
  txn('plaid-txn-streamly-2', 'Streamly', 12.99, daysAgo(35)),
  txn('plaid-txn-grocer-1', 'Grocer', 90, daysAgo(20)),
  txn('plaid-txn-grocer-2', 'Grocer', 90, daysAgo(14)),
  txn('plaid-txn-grocer-3', 'Grocer', 90, daysAgo(9)),
];
// The recent week (page 2): the Streamly price hike, an outsized Jetstore charge, a pending card swipe.
const PAGE_TWO = [
  txn('plaid-txn-streamly-3', 'Streamly', 15.99, daysAgo(5)),
  txn('plaid-txn-jetstore', 'Jetstore', 400, daysAgo(3)),
  txn('plaid-txn-pending', 'Cafe', 25, daysAgo(2), true),
];
// The incremental page: the pending swipe posts under a new id, so the old one is removed.
const PAGE_INCREMENTAL = [txn('plaid-txn-cafe-posted', 'Cafe', 25, daysAgo(2))];

/** What the scripted Plaid does with the next /transactions/sync call past the initial pages. */
let syncMode: 'initial' | 'incremental' | 'authError' = 'initial';
/** Every path the stand-in served, so tests can assert what was (and wasn't) called. */
const plaidCalls: string[] = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const plaid: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8');
  });
  req.on('end', () => {
    const path = req.url ?? '/';
    plaidCalls.push(path);
    if (path === '/link/token/create') {
      json(res, 200, { link_token: LINK_TOKEN });
      return;
    }
    if (path === '/item/public_token/exchange') {
      json(res, 200, { access_token: ACCESS_TOKEN, item_id: ITEM_ID });
      return;
    }
    if (path === '/accounts/balance/get') {
      json(res, 200, {
        accounts: [
          {
            account_id: 'acct-checking',
            name: 'Everyday Checking',
            type: 'depository',
            subtype: 'checking',
            mask: '0000',
            balances: { available: 60, current: 60, iso_currency_code: 'USD' },
          },
          {
            account_id: 'acct-card',
            name: 'Rewards Card',
            type: 'credit',
            subtype: 'credit card',
            mask: '9999',
            balances: { available: null, current: 250, iso_currency_code: 'USD' },
          },
        ],
      });
      return;
    }
    if (path === '/transactions/sync') {
      if (syncMode === 'authError') {
        json(res, 400, {
          error_type: 'ITEM_ERROR',
          error_code: 'ITEM_LOGIN_REQUIRED',
          error_message: 'the login details of this item have changed',
        });
        return;
      }
      const body: { cursor?: string } = raw.length > 0 ? JSON.parse(raw) : {};
      const cursor = body.cursor;
      if (cursor === undefined) {
        json(res, 200, { added: PAGE_ONE, modified: [], removed: [], next_cursor: 'cur-1', has_more: true });
        return;
      }
      if (cursor === 'cur-1') {
        json(res, 200, { added: PAGE_TWO, modified: [], removed: [], next_cursor: 'cur-2', has_more: false });
        return;
      }
      if (cursor === 'cur-2' && syncMode === 'incremental') {
        json(res, 200, {
          added: PAGE_INCREMENTAL,
          modified: [],
          removed: [{ transaction_id: 'plaid-txn-pending' }],
          next_cursor: 'cur-3',
          has_more: false,
        });
        return;
      }
      json(res, 200, { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false });
      return;
    }
    if (path === '/item/remove') {
      json(res, 200, { request_id: 'req-remove' });
      return;
    }
    json(res, 404, {
      error_type: 'INVALID_REQUEST',
      error_code: 'UNKNOWN_ENDPOINT',
      error_message: `unscripted plaid path: ${path}`,
    });
  });
});

await new Promise<void>((resolve) => plaid.listen(0, '127.0.0.1', resolve));
const plaidAddress = plaid.address();
if (plaidAddress === null || typeof plaidAddress === 'string') {
  throw new Error('plaid stand-in failed to bind a port');
}

process.env['MONEY_AGGREGATOR_ENABLED'] = 'true';
process.env['PLAID_CLIENT_ID'] = 'stand-in-client';
process.env['PLAID_SECRET'] = `stand-in-${randomBytes(8).toString('hex')}`;
process.env['PLAID_API_BASE_URL'] = `http://127.0.0.1:${plaidAddress.port}`;

// Everything that reads config loads only AFTER the environment above is set.
const { db, closeDb } = await import('../database/index.js');
const { config } = await import('../config/unifiedConfig.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const connectionRoutes = (await import('../routes/connections.js')).default;
const { broker } = await import('../control-plane/broker/broker.js');
const { transactionSyncService } = await import('../services/transactionSyncService.js');
const { vault } = await import('../control-plane/vault/vault.js');
const { decryptField } = await import('../control-plane/vault/fieldCrypto.js');

const app = express();
app.use(express.json());
app.use('/connections', connectionRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const serverAddress = server.address();
if (serverAddress === null || typeof serverAddress === 'string') {
  throw new Error('api server failed to bind a port');
}
const API = `http://127.0.0.1:${serverAddress.port}`;

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdConnections: string[] = [];
const createdVaultRefs: string[] = [];

interface TestUser {
  readonly id: string;
  readonly auth: string;
}

async function createUser(): Promise<TestUser> {
  const row = await db
    .insertInto('users')
    .values({
      email: `money-conn-${randomUUID()}@stewra.invalid`,
      display_name: 'Money Connection Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const auth = `Bearer ${jwt.sign({ sub: row.id, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
  return { id: row.id, auth };
}

/** The user's aggregator connection row, straight from the table (the tests assert on storage). */
async function connectionRowFor(userId: string) {
  const row = await db
    .selectFrom('connections')
    .selectAll()
    .where('user_id', '=', userId)
    .where('provider', '=', 'aggregator')
    .executeTakeFirstOrThrow();
  if (!createdConnections.includes(row.id)) {
    createdConnections.push(row.id);
    createdVaultRefs.push(row.vault_ref);
  }
  return row;
}

const userA = await createUser();

afterAll(async () => {
  // Deleting the connection cascades money_accounts/transactions/sync_state. Users stay (see header).
  for (const id of createdConnections) {
    await db.deleteFrom('connections').where('id', '=', id).execute();
  }
  for (const ref of createdVaultRefs) {
    await db.deleteFrom('vault_secrets').where('id', '=', ref).execute();
  }
  server.close();
  plaid.close();
  await closeDb();
});

describe('connecting a bank through Plaid Link', () => {
  it('hands out the plain-language consent and a Link token — to authenticated users only', async () => {
    const anonymous = await request(API).post('/connections/plaid/start');
    expect(anonymous.status).toBe(401);

    const res = await request(API).post('/connections/plaid/start').set('Authorization', userA.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.consentPrompt).toContain('read-only');
    expect(res.body.data.linkToken).toBe(LINK_TOKEN);
  });

  it('exchanges the public token, vaults the access token, and fills the store on first sync', async () => {
    syncMode = 'initial';
    const res = await request(API)
      .post('/connections/plaid/exchange')
      .set('Authorization', userA.auth)
      .send({ publicToken: 'public-sandbox-stand-in' });
    expect(res.status).toBe(200);
    expect(res.body.data.connection.provider).toBe('aggregator');
    expect(res.body.data.connection.accountEmail).toBe(ITEM_ID);
    expect(res.body.data.connection.status).toBe('active');
    // An aggregator connection must never trip the "reconnect Google" banner.
    expect(res.body.data.connection.needsReconsent).toBe(false);
    // The token itself must appear nowhere in the response.
    expect(JSON.stringify(res.body)).not.toContain(ACCESS_TOKEN);

    const row = await connectionRowFor(userA.id);
    await expect(vault.get(row.vault_ref)).resolves.toBe(ACCESS_TOKEN);

    const accounts = await db
      .selectFrom('money_accounts')
      .selectAll()
      .where('connection_id', '=', row.id)
      .execute();
    expect(accounts).toHaveLength(2);
    const checking = accounts.find((a) => a.plaid_account_id === 'acct-checking');
    expect(checking?.available_micros).toBe('60000000');

    const transactions = await db
      .selectFrom('money_transactions')
      .selectAll()
      .where('connection_id', '=', row.id)
      .execute();
    expect(transactions).toHaveLength(PAGE_ONE.length + PAGE_TWO.length);
    // Merchant text is encrypted at rest: no plaintext on the row, and the envelope round-trips.
    const jetstore = transactions.find((t) => t.plaid_transaction_id === 'plaid-txn-jetstore');
    expect(jetstore).toBeDefined();
    expect(jetstore?.merchant_ciphertext).not.toContain('Jetstore');
    expect(decryptField(jetstore?.merchant_ciphertext ?? '')).toBe('Jetstore');

    const state = await db
      .selectFrom('money_sync_state')
      .selectAll()
      .where('connection_id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(state.cursor).toBe('cur-2');
    expect(state.initial_sync_complete).toBe(true);
  });

  it('serves money facts through the broker — short strings, never records — and denies the unconnected', async () => {
    const result = await broker.request({
      userId: userA.id,
      kind: 'money',
      purpose: 'test: derived money facts',
      params: {},
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) {
      throw new Error('unreachable');
    }
    expect(result.facts.find((f) => f.includes('covers roughly'))).toBeDefined();
    expect(result.facts.find((f) => f.includes('much larger than your typical charge'))).toBeDefined();
    expect(result.facts.find((f) => f.includes('recurring charge at Streamly has risen'))).toBeDefined();
    // Nothing resembling a raw record crosses: no ids, no tokens, no account references.
    for (const fact of result.facts) {
      expect(fact).not.toContain('plaid-txn');
      expect(fact).not.toContain('acct-');
      expect(fact).not.toContain(ACCESS_TOKEN);
    }

    const unconnected = await createUser();
    const denied = await broker.request({
      userId: unconnected.id,
      kind: 'money',
      purpose: 'test: no connection',
      params: {},
    });
    expect(denied.allowed).toBe(false);
  });

  it('walks the cursor incrementally: the pending charge is replaced by its posted version', async () => {
    syncMode = 'incremental';
    await transactionSyncService.syncForUser(userA.id);

    const row = await connectionRowFor(userA.id);
    const ids = (
      await db
        .selectFrom('money_transactions')
        .select('plaid_transaction_id')
        .where('connection_id', '=', row.id)
        .execute()
    ).map((r) => r.plaid_transaction_id);
    expect(ids).toContain('plaid-txn-cafe-posted');
    expect(ids).not.toContain('plaid-txn-pending');

    const state = await db
      .selectFrom('money_sync_state')
      .selectAll()
      .where('connection_id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(state.cursor).toBe('cur-3');
  });

  it('revokes the connection when the bank grant is terminally lost, closing the money facts door', async () => {
    syncMode = 'authError';
    await transactionSyncService.syncForUser(userA.id);

    const row = await connectionRowFor(userA.id);
    expect(row.status).toBe('revoked');

    const denied = await broker.request({
      userId: userA.id,
      kind: 'money',
      purpose: 'test: after grant loss',
      params: {},
    });
    expect(denied.allowed).toBe(false);
  });

  it('disconnect severs the Item at Plaid, empties the vault, and purges the store', async () => {
    syncMode = 'initial';
    const userB = await createUser();
    const connected = await request(API)
      .post('/connections/plaid/exchange')
      .set('Authorization', userB.auth)
      .send({ publicToken: 'public-sandbox-stand-in' });
    expect(connected.status).toBe(200);
    const row = await connectionRowFor(userB.id);

    const removeCallsBefore = plaidCalls.filter((p) => p === '/item/remove').length;
    const res = await request(API)
      .post(`/connections/${row.id}/disconnect`)
      .set('Authorization', userB.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.connection.status).toBe('revoked');

    expect(plaidCalls.filter((p) => p === '/item/remove').length).toBe(removeCallsBefore + 1);
    await expect(vault.get(row.vault_ref)).rejects.toThrow(/no secret/);

    const remaining = await db
      .selectFrom('money_transactions')
      .select('id')
      .where('connection_id', '=', row.id)
      .execute();
    expect(remaining).toHaveLength(0);
    const accounts = await db
      .selectFrom('money_accounts')
      .select('id')
      .where('connection_id', '=', row.id)
      .execute();
    expect(accounts).toHaveLength(0);
  });
});
