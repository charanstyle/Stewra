import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { Server as SocketServer } from 'socket.io';
import { io as connectClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { RUNNER_CLIENT_EVENTS, RUNNER_SERVER_EVENTS } from '@stewra/shared-types';
import type { RunnerUpdateAvailablePayload } from '@stewra/shared-types';
import type { AppServer } from '../websocket/types.js';
// Type-only, so they are erased and do NOT load these modules here — the graph is still imported
// dynamically below, after this file has set the environment the config reads at module load.
import type * as errorTypes from '../utils/errors.js';
import type { db, closeDb } from '../database/index.js';
import type { redis } from '../services/redisClient.js';
import type { runnerService } from '../services/runnerService.js';
import type { runnerDeviceRepository } from '../repositories/runnerDeviceRepository.js';
import type { initSockets } from '../websocket/index.js';

/**
 * The server side of the Stewra Runner, end to end and with nothing stood in for.
 *
 * The chain that authorises a machine to run coding agents for a user is: authenticated user mints a
 * single-use pairing code → the runner burns it for a device token → that token is the only thing the
 * `/runner` namespace will seat. Every link is checked server-side, and these tests exist so no link
 * can be skipped — because the thing on the other end executes code.
 *
 * Everything runs against the real `stewra_test` Postgres and the real Redis, through a real
 * Socket.IO server booted by the SAME `initSockets` the app boots, with genuine `socket.io-client`
 * runners on the other end. The claims under test — "the code burns atomically", "revoke deletes the
 * row and the socket", "online is composed from who is connected" — are claims about rows,
 * transactions, and frames, which a substituted collaborator would assert nothing about. What is
 * absent is only what genuinely lives on the user's machine: the runner binary and its harnesses.
 */

const DOWNLOAD_URL = 'https://downloads.example.test/stewra-runner';
const MIN_VERSION = '0.2.0';
const LATEST_VERSION = '0.3.0';

/** How long a negative assertion waits before concluding nothing is going to happen. */
const QUIET_MS = 1_500;

// ---------------------------------------------------------------------------------------------
// Config, from the environment, exactly as a deploy does it — pinned before the graph is imported.
// ---------------------------------------------------------------------------------------------

process.env['RUNNER_DOWNLOAD_URL'] = DOWNLOAD_URL;
process.env['RUNNER_MIN_VERSION'] = MIN_VERSION;
process.env['RUNNER_LATEST_VERSION'] = LATEST_VERSION;

interface Graph {
  readonly initSockets: typeof initSockets;
  readonly service: typeof runnerService;
  readonly repository: typeof runnerDeviceRepository;
  readonly redis: typeof redis;
  readonly errors: typeof errorTypes;
  readonly db: typeof db;
  readonly closeDb: typeof closeDb;
}

async function loadGraph(enabled: boolean): Promise<Graph> {
  process.env['RUNNER_ENABLED'] = enabled ? 'true' : 'false';
  vi.resetModules();
  const { initSockets } = await import('../websocket/index.js');
  const { runnerService } = await import('../services/runnerService.js');
  const { runnerDeviceRepository } = await import('../repositories/runnerDeviceRepository.js');
  const { redis } = await import('../services/redisClient.js');
  const errors = await import('../utils/errors.js');
  const database = await import('../database/index.js');
  return {
    initSockets,
    service: runnerService,
    repository: runnerDeviceRepository,
    redis,
    errors,
    db: database.db,
    closeDb: database.closeDb,
  };
}

const on = await loadGraph(true);
// A second, independently-configured copy of the application with the feature switched off — a flag
// is a property of a process, so "off" is a different process, not a mutated field.
const off = await loadGraph(false);

/** Boot a real Socket.IO server through the app's own `initSockets`, and return where to reach it. */
async function bootServer(graph: Graph): Promise<{ http: HttpServer; io: AppServer; url: string }> {
  const http = createServer();
  const io: AppServer = new SocketServer(http, { transports: ['websocket'] });
  graph.initSockets(io);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return { http, io, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
}

const live = await bootServer(on);
const dark = await bootServer(off);

// ---------------------------------------------------------------------------------------------
// Waiting. Nothing here is synchronous — a frame crosses a socket, a row lands in Postgres — so
// assertions poll for the state they need instead of assuming a turn of the event loop was enough.
// ---------------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

// One real bcrypt hash, reused: no test here authenticates with a password, and hashing throwaway
// passwords at the configured cost factor would add seconds to the run for no coverage.
const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];

/** A real `users` row — every table below is foreign-keyed to one, so there is no shortcut. */
async function createUser(): Promise<string> {
  const row = await on.db
    .insertInto('users')
    .values({
      email: `runner-${randomUUID()}@stewra.invalid`,
      display_name: 'Runner Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

/** Pairing code minted and burned through the real service — the state most tests start from. */
async function pairDevice(
  userId: string,
  appVersion = MIN_VERSION,
): Promise<{ token: string; deviceId: string }> {
  const { code } = await on.service.startPairing(userId);
  const claimed = await on.service.claimToken({
    code,
    deviceName: "Robin's MacBook",
    appVersion,
    os: 'darwin',
  });
  return { token: claimed.token, deviceId: claimed.device.id };
}

// ---------------------------------------------------------------------------------------------
// A real runner client: the Stewra Runner minus the harnesses and repos, which live on the user's
// machine by design. What it speaks is the real protocol over a real socket.
// ---------------------------------------------------------------------------------------------

class RunnerClient {
  /** Every update-available nudge the server sent this runner. */
  readonly updateNudges: RunnerUpdateAvailablePayload[] = [];
  /** Set once the server tells this runner it has been revoked. */
  revoked = false;

  constructor(readonly socket: ClientSocket) {
    socket.on(RUNNER_SERVER_EVENTS.UPDATE_AVAILABLE, (payload: RunnerUpdateAvailablePayload) => {
      this.updateNudges.push(payload);
    });
    socket.on(RUNNER_SERVER_EVENTS.REVOKED, () => {
      this.revoked = true;
    });
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  hello(appVersion = MIN_VERSION): void {
    this.socket.emit(RUNNER_CLIENT_EVENTS.HELLO, {
      appVersion,
      os: 'darwin',
      harnesses: [{ id: 'claude-code', available: true, version: '2.0.1 (Claude Code)' }],
      workspaces: [
        {
          id: 'ws_0123456789ab',
          name: 'stewra (work laptop)',
          path: '/Users/robin/projects/stewra',
          gitRemote: 'git@github.com:example/stewra.git',
          defaultBranch: 'main',
        },
      ],
    });
  }
}

const clients: ClientSocket[] = [];

/** Connect to `/runner` and resolve once the handshake succeeds, or reject with the server's reason. */
async function connectRunner(token: string, url = live.url): Promise<RunnerClient> {
  const socket = connectClient(`${url}/runner`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err: Error) => reject(err));
  });
  return new RunnerClient(socket);
}

/** The same handshake, but for the cases where being REFUSED is the expected outcome. */
async function refusedRunner(auth: Record<string, unknown>, url = live.url): Promise<Error> {
  const socket = connectClient(`${url}/runner`, {
    auth,
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(socket);
  return new Promise<Error>((resolve, reject) => {
    socket.once('connect', () => reject(new Error('the handshake was accepted, and should not have been')));
    socket.once('connect_error', (err: Error) => resolve(err));
  });
}

afterEach(() => {
  for (const socket of clients.splice(0)) socket.disconnect();
});

afterAll(async () => {
  for (const socket of clients.splice(0)) socket.disconnect();
  await Promise.all(
    [live, dark].map(
      ({ io, http }) =>
        new Promise<void>((resolve) => {
          io.close(() => http.close(() => resolve()));
        }),
    ),
  );

  // `initSockets` builds the Socket.IO Redis adapter's own pub/sub pair and hands it to the adapter,
  // which owns it for the process lifetime. A test process does have to end, so they are closed here
  // through the adapter that holds them.
  for (const graph of [on, off]) {
    await graph.redis.quit().catch(() => undefined);
  }
  for (const { io } of [live, dark]) {
    const adapter = io.of('/').adapter as unknown as {
      pubClient?: { quit: () => Promise<unknown> };
      subClient?: { quit: () => Promise<unknown> };
    };
    await adapter.pubClient?.quit().catch(() => undefined);
    await adapter.subClient?.quit().catch(() => undefined);
  }

  // Users are deleted where possible — runner_devices and runner_pair_codes cascade from them. Those
  // that gained an audit row STAY: `audit_log.user_id` is ON DELETE SET NULL, and the table's
  // append-only trigger rejects that UPDATE, so the delete would fail. That is the audit log working
  // as designed, not an obstacle to route around.
  if (createdUsers.length > 0) {
    await on.db
      .deleteFrom('users')
      .where('id', 'in', createdUsers)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id'))),
      )
      .execute();
  }
  await Promise.all([on.closeDb(), off.closeDb()]);
});

// ---------------------------------------------------------------------------------------------
// Pairing: code → token, each property of the chain checked against the real rows.
// ---------------------------------------------------------------------------------------------

describe('pairing', () => {
  it('mints a copyable code, burns it for a token, and registers the device for real', async () => {
    const userId = await createUser();

    const pairing = await on.service.startPairing(userId);
    // The user copies this by hand into a terminal — the alphabet has no O/0, I/1, S/5, B/8.
    expect(pairing.code).toMatch(/^STEWRA-[ACDEFGHJKLMNPQRTUVWXYZ2346789]{8}$/);
    expect(pairing.downloadUrl).toBe(DOWNLOAD_URL);
    expect(new Date(pairing.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const claimed = await on.service.claimToken({
      code: pairing.code,
      deviceName: "Robin's MacBook",
      appVersion: MIN_VERSION,
      os: 'darwin',
    });
    // The token is greppable-by-prefix and returned exactly once, here.
    expect(claimed.token).toMatch(/^stwrn_/);
    expect(claimed.device.name).toBe("Robin's MacBook");
    expect(claimed.device.online).toBe(false);

    // The row is real, and stores a hash — never the token itself.
    const row = await on.db
      .selectFrom('runner_devices')
      .selectAll()
      .where('id', '=', claimed.device.id)
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBe(userId);
    expect(row.token_hash).not.toContain(claimed.token);

    // Linking a machine that can run code is audited.
    const audit = await on.db
      .selectFrom('audit_log')
      .select(['action', 'summary'])
      .where('user_id', '=', userId)
      .execute();
    expect(audit.some((a) => a.action === 'connect' && a.summary.includes('Stewra Runner'))).toBe(true);
  });

  it('refuses a build below the version floor BEFORE burning the code', async () => {
    const userId = await createUser();
    const { code } = await on.service.startPairing(userId);

    await expect(
      on.service.claimToken({ code, deviceName: 'Old Build', appVersion: '0.1.0', os: 'darwin' }),
    ).rejects.toBeInstanceOf(on.errors.ForbiddenError);

    // The refusal came before the burn: the same code still works once the build is current. Without
    // that ordering the user would spend their code just to be told to upgrade.
    const claimed = await on.service.claimToken({
      code,
      deviceName: 'Updated Build',
      appVersion: MIN_VERSION,
      os: 'darwin',
    });
    expect(claimed.device.name).toBe('Updated Build');
  });

  it('rejects a code that is unknown, already used, or expired', async () => {
    const userId = await createUser();

    await expect(
      on.service.claimToken({ code: 'STEWRA-NOTACODE', deviceName: 'X', appVersion: MIN_VERSION, os: 'darwin' }),
    ).rejects.toBeInstanceOf(on.errors.AuthenticationError);

    // Already used.
    const { code } = await on.service.startPairing(userId);
    await on.service.claimToken({ code, deviceName: 'First', appVersion: MIN_VERSION, os: 'darwin' });
    await expect(
      on.service.claimToken({ code, deviceName: 'Second', appVersion: MIN_VERSION, os: 'darwin' }),
    ).rejects.toBeInstanceOf(on.errors.AuthenticationError);

    // Expired — the clock is moved on the real row, and the WHERE clause is what enforces it.
    const { code: expired } = await on.service.startPairing(userId);
    await on.db
      .updateTable('runner_pair_codes')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('code', '=', expired)
      .execute();
    await expect(
      on.service.claimToken({ code: expired, deviceName: 'Late', appVersion: MIN_VERSION, os: 'darwin' }),
    ).rejects.toBeInstanceOf(on.errors.AuthenticationError);
  });

  it('invalidates the previous unconsumed code when a new one is minted', async () => {
    const userId = await createUser();
    const first = await on.service.startPairing(userId);
    const second = await on.service.startPairing(userId);

    // Only the code the user was most recently shown can work.
    await expect(
      on.service.claimToken({ code: first.code, deviceName: 'Stale', appVersion: MIN_VERSION, os: 'darwin' }),
    ).rejects.toBeInstanceOf(on.errors.AuthenticationError);
    const claimed = await on.service.claimToken({
      code: second.code,
      deviceName: 'Fresh',
      appVersion: MIN_VERSION,
      os: 'darwin',
    });
    expect(claimed.device.name).toBe('Fresh');
  });

  it('lets exactly one of two racing claims win the same code', async () => {
    const userId = await createUser();
    const { code } = await on.service.startPairing(userId);

    // The atomic guard is the UPDATE's WHERE clause — two racing claims cannot both match the row.
    const results = await Promise.allSettled([
      on.service.claimToken({ code, deviceName: 'Racer A', appVersion: MIN_VERSION, os: 'darwin' }),
      on.service.claimToken({ code, deviceName: 'Racer B', appVersion: MIN_VERSION, os: 'darwin' }),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.reason).toBeInstanceOf(on.errors.AuthenticationError);

    // Exactly one device row came out of it.
    const rows = await on.db
      .selectFrom('runner_devices')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Token authentication — the one function the `/runner` namespace trusts completely.
// ---------------------------------------------------------------------------------------------

describe('authenticateRunner', () => {
  it('resolves a real token, and nothing else', async () => {
    const userId = await createUser();
    const { token, deviceId } = await pairDevice(userId);

    // `kind` travels with the identity because hosted-only endpoints decide on it. A device that came
    // through PAIRING is 'local', always — that is the laptop invariant's first link.
    await expect(on.service.authenticateRunner(token)).resolves.toEqual({ deviceId, userId, kind: 'local' });
    await expect(on.service.authenticateRunner('stwrn_forged')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The live socket: online composition, capability reporting, and the upgrade nudge.
// ---------------------------------------------------------------------------------------------

describe('a runner on the /runner namespace', () => {
  it('is refused without a valid token', async () => {
    const err = await refusedRunner({ token: 'stwrn_forged' });
    expect(err.message.toLowerCase()).toContain('token');
  });

  it('shows online while its socket is connected, and offline again after — composed, never stored', async () => {
    const userId = await createUser();
    const { token, deviceId } = await pairDevice(userId);

    const before = await on.service.listDevices(userId);
    expect(before.devices.find((d) => d.id === deviceId)?.online).toBe(false);

    const runner = await connectRunner(token);
    await waitFor('the device to show online', async () => {
      const { devices } = await on.service.listDevices(userId);
      return devices.find((d) => d.id === deviceId)?.online === true;
    });

    runner.socket.disconnect();
    await waitFor('the device to show offline', async () => {
      const { devices } = await on.service.listDevices(userId);
      return devices.find((d) => d.id === deviceId)?.online === false;
    });
  });

  it('persists what a hello reports, so the panel can render what the machine can do', async () => {
    const userId = await createUser();
    const { token, deviceId } = await pairDevice(userId);

    const runner = await connectRunner(token);
    runner.hello(LATEST_VERSION);

    const device = await waitFor('the hello to be persisted', async () => {
      const { devices } = await on.service.listDevices(userId);
      const d = devices.find((x) => x.id === deviceId);
      return d !== undefined && d.harnesses.length > 0 ? d : null;
    });
    expect(device.harnesses).toEqual([
      { id: 'claude-code', available: true, version: '2.0.1 (Claude Code)' },
    ]);
    expect(device.workspaces[0]?.name).toBe('stewra (work laptop)');
    expect(device.lastSeenAt).not.toBeNull();
  });

  it('follows the build a machine actually runs, not the one it paired with', async () => {
    const userId = await createUser();
    // Paired on the oldest allowed build, then upgraded — the ordinary life of a runner.
    const { token, deviceId } = await pairDevice(userId, MIN_VERSION);

    const runner = await connectRunner(token);
    runner.hello(LATEST_VERSION);

    // Without this the row keeps MIN_VERSION forever, and the panel goes on telling a user who HAS
    // upgraded that they are out of date — a nag with no action that clears it.
    const device = await waitFor('the reported version to be persisted', async () => {
      const { devices } = await on.service.listDevices(userId);
      const d = devices.find((x) => x.id === deviceId);
      return d !== undefined && d.appVersion === LATEST_VERSION ? d : null;
    });
    expect(device.appVersion).toBe(LATEST_VERSION);
  });

  it('nudges an out-of-date build toward the download — and never a current one', async () => {
    const userId = await createUser();
    const { token } = await pairDevice(userId);

    const stale = await connectRunner(token);
    stale.hello(MIN_VERSION); // 0.2.0 < 0.3.0: behind the latest published build.
    const nudge = await waitFor('the update nudge', () => stale.updateNudges[0]);
    expect(nudge).toEqual({ latestVersion: LATEST_VERSION, downloadUrl: DOWNLOAD_URL });
    stale.socket.disconnect();

    const current = await connectRunner(token);
    current.hello(LATEST_VERSION);
    await sleep(QUIET_MS);
    expect(current.updateNudges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Revocation — instant, because the token is a row, and the row is gone.
// ---------------------------------------------------------------------------------------------

describe('revokeDevice', () => {
  it('deletes the row, kills the token, and hangs up on the live socket', async () => {
    const userId = await createUser();
    const { token, deviceId } = await pairDevice(userId);
    const runner = await connectRunner(token);

    const revoked = await on.service.revokeDevice(userId, deviceId);
    expect(revoked).toBe(true);

    // The runner is told to stop NOW, then cut off.
    await waitFor('the revoked notice', () => runner.revoked);
    await waitFor('the socket to be closed', () => !runner.connected);

    // The row no longer exists, so the token authenticates as nothing …
    await expect(on.service.authenticateRunner(token)).resolves.toBeNull();
    // … and a reconnect with it is indistinguishable from a forgery.
    await expect(refusedRunner({ token })).resolves.toBeInstanceOf(Error);
  });

  it("changes nothing when the device id is someone else's, or nobody's", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { token, deviceId } = await pairDevice(owner);
    const runner = await connectRunner(token);

    await expect(on.service.revokeDevice(stranger, deviceId)).resolves.toBe(false);
    await expect(on.service.revokeDevice(owner, randomUUID())).resolves.toBe(false);

    // A revoke that deleted nothing must not knock a live runner off.
    await sleep(QUIET_MS);
    expect(runner.connected).toBe(true);
    expect(runner.revoked).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The kill switch: a deploy with the feature off has no runner surface at all.
// ---------------------------------------------------------------------------------------------

describe('with RUNNER_ENABLED=false', () => {
  it('refuses to mint, claim, or authenticate — and reports itself disabled', async () => {
    const userId = await createUser();
    const { token } = await pairDevice(userId); // Minted through the enabled graph; same database.

    await expect(off.service.startPairing(userId)).rejects.toBeInstanceOf(
      off.errors.ServiceUnavailableError,
    );
    await expect(
      off.service.claimToken({ code: 'STEWRA-AAAAAAAA', deviceName: 'X', appVersion: MIN_VERSION, os: 'darwin' }),
    ).rejects.toBeInstanceOf(off.errors.ServiceUnavailableError);
    // Even a genuinely valid token is nothing here — the flag gates the trust root itself.
    await expect(off.service.authenticateRunner(token)).resolves.toBeNull();

    const status = await off.service.getStatus(userId);
    expect(status.enabled).toBe(false);
    expect(status.devices).toEqual([]);
  });

  it('does not even mount the /runner namespace', async () => {
    const userId = await createUser();
    const { token } = await pairDevice(userId);

    // Socket.IO's refusal for a namespace that was never created.
    const err = await refusedRunner({ token }, dark.url);
    expect(err.message).toContain('Invalid namespace');
  });
});
