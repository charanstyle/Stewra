import { generateKeyPairSync, randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
// Type-only, so they are erased and do NOT load these modules here — the graph is still imported
// dynamically below, after this file has set the environment the config reads at module load.
import type * as errorTypes from '../utils/errors.js';
import type { db, closeDb } from '../database/index.js';
import type { redis } from '../services/redisClient.js';
import type { hostedRunnerService } from '../services/hostedRunnerService.js';
import type { runnerService } from '../services/runnerService.js';
import type { runnerDeviceRepository } from '../repositories/runnerDeviceRepository.js';

/**
 * The Stewra-hosted cloud runner, end to end and with nothing stood in for.
 *
 * What this suite is defending is not a feature but a set of promises about infrastructure Stewra
 * creates, runs, and pays for on a user's behalf:
 *
 *   - a provision that fails part-way leaves NOTHING behind — no row the user can see and not use, no
 *     container burning host resources for a device that does not exist;
 *   - a runner that is revoked or destroyed takes its container with it, and its token dies first;
 *   - a credential Stewra minted reaches a container Stewra runs, and NEVER a machine it does not
 *     control — the laptop invariant, checked over real HTTP through the real middleware chain;
 *   - the backend cannot choose what image its containers run, cannot smuggle environment into them,
 *     and cannot address a container it did not create.
 *
 * The database is the real `stewra_test` Postgres. GitHub is a real HTTP server that verifies every App
 * JWT with the App's public key. The provisioner is a real HTTP server implementing the Phase 2 contract
 * FAITHFULLY — it checks the bearer token, refuses an image that is not its own, refuses environment
 * keys outside the allowlist, 404s an unknown device, and 409s a duplicate name, exactly as the real one
 * does. A stand-in that said yes to everything would let a backend bug that sends the wrong image, or a
 * forbidden variable, pass this suite and fail in production; this one fails the test instead.
 *
 * What is genuinely absent is Docker itself — the provisioner's own suite drives a real daemon
 * (provisioner/src/tests/provisioner.test.ts), which is where that belongs.
 */

const APP_ID = '424242';
const APP_SLUG = 'stewra-hosted-test';
const RUNNER_IMAGE = 'stewra-runner:test-0.1.0';
const PROVISIONER_TOKEN = `prov_${randomUUID()}${randomUUID()}`.replace(/-/g, '');
const PUBLIC_API_URL = 'https://api.stewra.invalid';
const WAKE_TIMEOUT_SECONDS = 10;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

// ---------------------------------------------------------------------------------------------
// The scripted GitHub — enough of the App API for provisioning and git credentials to be real.
// ---------------------------------------------------------------------------------------------

interface FakeInstallation {
  accountLogin: string;
  repos: { full_name: string; clone_url: string; default_branch: string; private: boolean }[];
}

const installations = new Map<number, FakeInstallation>();
const mintedTokens = new Map<string, number>();
/** Every request the scripted services refused, with a reason — asserted empty after every test. */
const rejections: string[] = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

function verifyAppJwt(req: IncomingMessage): boolean {
  try {
    const payload = jwt.verify(bearer(req), PUBLIC_PEM, { algorithms: ['RS256'] }) as jwt.JwtPayload;
    if (payload.iss !== APP_ID) {
      rejections.push(`github: app jwt issuer ${String(payload.iss)} is not the App id`);
      return false;
    }
    return true;
  } catch (error) {
    rejections.push(`github: app jwt rejected: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

const github = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://github.invalid');

  const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
  if (mint !== null && req.method === 'POST') {
    if (!verifyAppJwt(req)) return json(res, 401, { message: 'Bad credentials' });
    const id = Number(mint[1]);
    if (!installations.has(id)) return json(res, 404, { message: 'Not Found' });
    const token = `ghs_${id}_${randomInt(1, 1_000_000)}`;
    mintedTokens.set(token, id);
    return json(res, 201, {
      token,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  }

  if (url.pathname === '/installation/repositories' && req.method === 'GET') {
    const id = mintedTokens.get(bearer(req));
    const installation = id === undefined ? undefined : installations.get(id);
    if (installation === undefined) {
      rejections.push('github: repositories called without a live installation token');
      return json(res, 401, { message: 'Bad credentials' });
    }
    return json(res, 200, {
      total_count: installation.repos.length,
      repositories: installation.repos,
    });
  }

  rejections.push(`github: unexpected request ${req.method ?? '?'} ${url.pathname}`);
  return json(res, 500, { message: 'the scripted GitHub has no such route' });
});
await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
const GITHUB_URL = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

// ---------------------------------------------------------------------------------------------
// The scripted provisioner. It enforces the Phase 2 contract rather than accepting whatever comes,
// so a backend that sends the wrong image or a forbidden env key fails HERE, in a test.
// ---------------------------------------------------------------------------------------------

/** The provisioner's own env allowlist (provisioner/src/api.ts) — copied because it IS the contract. */
const ENV_KEY_PATTERN = /^STEWRA_(API_URL|API_PREFIX|RUNNER_[A-Z0-9_]+)$/;

interface FakeContainer {
  deviceId: string;
  containerName: string;
  /** Docker's own vocabulary, because that is what the real provisioner reports. */
  status: 'created' | 'running' | 'exited';
  env: Record<string, string>;
  /** Written credential slots. The VALUES are held so a test can prove what reached the container. */
  credentials: Record<string, string>;
  volumesRemoved: boolean;
}

const containers = new Map<string, FakeContainer>();
/** Containers that were deleted, kept so "was it destroyed, and with its volumes?" is answerable. */
const destroyed: { deviceId: string; removeVolumes: boolean }[] = [];
/** Route keys the provisioner should fail once, e.g. 'POST /v1/runners' — how a partial failure is staged. */
const failOnce = new Set<string>();

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function view(container: FakeContainer): Record<string, string> {
  return {
    deviceId: container.deviceId,
    containerName: container.containerName,
    status: container.status,
    startedAt: new Date().toISOString(),
  };
}

const provisioner = createServer((req, res) => {
  void (async (): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://provisioner.invalid');
    const method = req.method ?? 'GET';

    if (url.pathname === '/healthz') return json(res, 200, { ok: true, dockerVersion: 'scripted' });

    if (bearer(req) !== PROVISIONER_TOKEN) {
      rejections.push(`provisioner: ${method} ${url.pathname} without the configured token`);
      return json(res, 401, { error: { message: 'missing or invalid provisioner token' } });
    }

    const routeKey = `${method} ${url.pathname.replace(/\/[0-9a-f-]{36}/i, '/:id')}`;
    if (failOnce.has(routeKey)) {
      failOnce.delete(routeKey);
      return json(res, 502, { error: { message: `scripted failure on ${routeKey}` } });
    }

    if (url.pathname === '/v1/runners' && method === 'POST') {
      const body = await readBody(req);
      const deviceId = String(body['deviceId'] ?? '');
      if (body['image'] !== RUNNER_IMAGE) {
        rejections.push(`provisioner: asked for image ${String(body['image'])}, which is not ${RUNNER_IMAGE}`);
        return json(res, 400, { error: { message: 'image mismatch' } });
      }
      const env = (body['env'] ?? {}) as Record<string, string>;
      const forbidden = Object.keys(env).filter((key) => !ENV_KEY_PATTERN.test(key));
      if (forbidden.length > 0) {
        rejections.push(`provisioner: env keys outside the allowlist: ${forbidden.join(', ')}`);
        return json(res, 400, { error: { message: `env keys not allowed: ${forbidden.join(', ')}` } });
      }
      if (containers.has(deviceId)) {
        return json(res, 409, { error: { message: 'container name already in use' } });
      }
      const container: FakeContainer = {
        deviceId,
        containerName: `stewra-runner-${deviceId}`,
        status: 'created',
        env,
        credentials: {},
        volumesRemoved: false,
      };
      containers.set(deviceId, container);
      return json(res, 201, view(container));
    }

    if (url.pathname === '/v1/runners' && method === 'GET') {
      return json(res, 200, {
        runners: [...containers.values()].map((c) => ({
          deviceId: c.deviceId,
          containerName: c.containerName,
          status: c.status,
        })),
      });
    }

    const single = /^\/v1\/runners\/([^/]+)$/.exec(url.pathname);
    if (single !== null) {
      const container = containers.get(single[1] ?? '');
      if (container === undefined) return json(res, 404, { error: { message: 'no such runner' } });
      if (method === 'GET') return json(res, 200, view(container));
      if (method === 'DELETE') {
        const removeVolumes = url.searchParams.get('removeVolumes') === 'true';
        container.volumesRemoved = removeVolumes;
        destroyed.push({ deviceId: container.deviceId, removeVolumes });
        containers.delete(container.deviceId);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    const action = /^\/v1\/runners\/([^/]+)\/(start|stop)$/.exec(url.pathname);
    if (action !== null && method === 'POST') {
      const container = containers.get(action[1] ?? '');
      if (container === undefined) return json(res, 404, { error: { message: 'no such runner' } });
      container.status = action[2] === 'start' ? 'running' : 'exited';
      return json(res, 200, view(container));
    }

    const credential = /^\/v1\/runners\/([^/]+)\/credentials\/([^/]+)$/.exec(url.pathname);
    if (credential !== null && method === 'PUT') {
      const container = containers.get(credential[1] ?? '');
      if (container === undefined) return json(res, 404, { error: { message: 'no such runner' } });
      const body = await readBody(req);
      container.credentials[credential[2] ?? ''] = String(body['secret'] ?? '');
      res.writeHead(204);
      res.end();
      return;
    }

    rejections.push(`provisioner: unexpected request ${method} ${url.pathname}`);
    return json(res, 404, { error: { message: 'no route' } });
  })();
});
await new Promise<void>((resolve) => provisioner.listen(0, '127.0.0.1', resolve));
const PROVISIONER_URL = `http://127.0.0.1:${(provisioner.address() as AddressInfo).port}`;

// ---------------------------------------------------------------------------------------------
// Config, from the environment, exactly as a deploy does it — pinned before the graph is imported.
// ---------------------------------------------------------------------------------------------

process.env['RUNNER_ENABLED'] = 'true';
process.env['RUNNER_DOWNLOAD_URL'] = 'https://downloads.example.test/stewra-runner';
process.env['RUNNER_MIN_VERSION'] = '0.1.0';
process.env['RUNNER_LATEST_VERSION'] = '0.2.0';
process.env['GITHUB_APP_ID'] = APP_ID;
process.env['GITHUB_APP_SLUG'] = APP_SLUG;
process.env['GITHUB_APP_PRIVATE_KEY_BASE64'] = Buffer.from(PRIVATE_PEM).toString('base64');
process.env['GITHUB_API_BASE_URL'] = GITHUB_URL;
process.env['HOSTED_RUNNER_ENABLED'] = 'true';
process.env['HOSTED_RUNNER_PROVISIONER_URL'] = PROVISIONER_URL;
process.env['HOSTED_RUNNER_PROVISIONER_TOKEN'] = PROVISIONER_TOKEN;
process.env['HOSTED_RUNNER_IMAGE'] = RUNNER_IMAGE;
process.env['HOSTED_RUNNER_API_URL'] = PUBLIC_API_URL;
process.env['HOSTED_RUNNER_IDLE_STOP_MINUTES'] = '60';
process.env['HOSTED_RUNNER_WAKE_TIMEOUT_SECONDS'] = String(WAKE_TIMEOUT_SECONDS);

vi.resetModules();
const { hostedRunnerService: service } = (await import('../services/hostedRunnerService.js')) as {
  hostedRunnerService: typeof hostedRunnerService;
};
const { runnerService: runners } = (await import('../services/runnerService.js')) as {
  runnerService: typeof runnerService;
};
const { runnerDeviceRepository: deviceRepo } = (await import(
  '../repositories/runnerDeviceRepository.js'
)) as { runnerDeviceRepository: typeof runnerDeviceRepository };
const errors = (await import('../utils/errors.js')) as typeof errorTypes;
const database = (await import('../database/index.js')) as { db: typeof db; closeDb: typeof closeDb };
const { redis: redisClient } = (await import('../services/redisClient.js')) as { redis: typeof redis };
const runnerRouter = (await import('../routes/runner.js')).default;
const { organizationRepository: orgRepo } = await import('../tenancy/repositories/organizationRepository.js');
const { errorHandler } = await import('../middleware/errorHandler.js');

/**
 * The REAL route table behind a real HTTP server. The device-token endpoints have to be exercised
 * through this, not by calling the controller: what is under test on those two is the MIDDLEWARE chain
 * — token → row → kind — and calling past it would assert nothing about the door being shut.
 */
const app = express();
app.use(express.json());
app.use('/api/runner', runnerRouter);
app.use(errorHandler);
const api = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => api.once('listening', resolve));
const API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];

async function createUser(): Promise<string> {
  const row = await database.db
    .insertInto('users')
    .values({
      email: `hosted-runner-${randomUUID()}@stewra.invalid`,
      display_name: 'Hosted Runner Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  // Every account is a tenant: provisioning resolves the user's acting org, so the user needs one.
  const { org } = await orgRepo.create({
    name: 'Hosted Runner Test Org',
    slug: `hosted-runner-test-${randomUUID()}`,
    kind: 'individual',
    createdBy: row.id,
  });
  orgOf.set(row.id, org.id);
  return row.id;
}

const orgOf = new Map<string, string>();

/** The `{orgId, userId}` pair the services take, for a user made by `createUser`. */
function actor(userId: string): { orgId: string; userId: string } {
  const orgId = orgOf.get(userId);
  if (orgId === undefined) throw new Error(`no org recorded for test user ${userId}`);
  return { orgId, userId };
}

/** A user with the GitHub App installed on `repoCount` repositories — the precondition for provisioning. */
async function createUserWithGithub(repoCount = 2): Promise<string> {
  const userId = await createUser();
  const installationId = randomInt(1_000_000, 2_000_000_000);
  installations.set(installationId, {
    accountLogin: 'robin-org',
    repos: Array.from({ length: repoCount }, (_, i) => ({
      full_name: `robin-org/repo-${i}`,
      clone_url: `https://github.com/robin-org/repo-${i}.git`,
      default_branch: 'main',
      private: true,
    })),
  });
  await database.db
    .insertInto('github_app_installations')
    .values({ user_id: userId, installation_id: installationId, account_login: 'robin-org' })
    .execute();
  return userId;
}

async function deviceRow(deviceId: string): Promise<{
  kind: string;
  container_name: string | null;
  container_status: string | null;
} | null> {
  const row = await database.db
    .selectFrom('runner_devices')
    .select(['kind', 'container_name', 'container_status'])
    .where('id', '=', deviceId)
    .executeTakeFirst();
  return row ?? null;
}

/** Register a local (paired) device the way the pairing path does, to prove the two kinds stay apart. */
async function pairLocalDevice(userId: string): Promise<{ deviceId: string; token: string }> {
  const { device, token } = await deviceRepo.registerDevice({
    orgId: actor(userId).orgId,
    userId,
    name: "Robin's laptop",
    appVersion: '0.2.0',
    os: 'darwin',
  });
  return { deviceId: device.id, token };
}

afterEach(() => {
  // A scripted service refused something the backend sent. Whatever the test was, THIS is the bug.
  expect(rejections).toEqual([]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await new Promise<void>((resolve) => github.close(() => resolve()));
  await new Promise<void>((resolve) => provisioner.close(() => resolve()));

  if (createdUsers.length > 0) {
    await database.db.deleteFrom('runner_sessions').where('user_id', 'in', createdUsers).execute();
    await database.db.deleteFrom('runner_devices').where('user_id', 'in', createdUsers).execute();
    await database.db.deleteFrom('github_app_installations').where('user_id', 'in', createdUsers).execute();
    // Users that gained an audit row cannot be deleted (audit_log is append-only), so they are left.
    await database.db
      .deleteFrom('users')
      .where('id', 'in', createdUsers)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id'))),
      )
      .execute();
  }
  await database.closeDb();
  redisClient.disconnect();
});

// ---------------------------------------------------------------------------------------------
// Provisioning: the row, the container, the credentials, and the start — all of it or none of it.
// ---------------------------------------------------------------------------------------------

describe('provision', () => {
  it('creates a hosted device whose container carries only allowlisted environment', async () => {
    const userId = await createUserWithGithub();

    const runner = await service.provision(userId, { 'claude-code': 'sk-ant-oat-scripted' });

    expect(runner.kind).toBe('hosted');
    expect(runner.containerStatus).toBe('running');
    expect(runner.name).toBe('Stewra Cloud Runner');

    const row = await deviceRow(runner.id);
    expect(row?.kind).toBe('hosted');
    expect(row?.container_name).toBe(`stewra-runner-${runner.id}`);
    expect(row?.container_status).toBe('running');

    const container = containers.get(runner.id);
    expect(container).toBeDefined();
    expect(container?.status).toBe('running');
    // The public origin, not an internal name: a container that cannot reach Stewra is inert.
    expect(container?.env['STEWRA_API_URL']).toBe(PUBLIC_API_URL);
    expect(container?.env['STEWRA_RUNNER_WORKSPACE_MODE']).toBe('backend');
    // The token the container authenticates with is a real, live device token — not a placeholder.
    const deviceToken = container?.env['STEWRA_RUNNER_DEVICE_TOKEN'] ?? '';
    expect(deviceToken).toMatch(/^stwrn_/);
    await expect(runners.authenticateRunner(deviceToken)).resolves.toEqual({
      deviceId: runner.id,
      // A hosted runner is provisioned into the user's acting org — resolved, never supplied.
      orgId: actor(userId).orgId,
      userId,
      kind: 'hosted',
    });
  });

  it('writes the provider login into the container and nowhere else', async () => {
    const userId = await createUserWithGithub();
    const secret = `sk-ant-oat-${randomUUID()}`;

    const runner = await service.provision(userId, { 'claude-code': secret });

    // It reached the container's credential slot...
    expect(containers.get(runner.id)?.credentials['claude-code']).toBe(secret);
    // ...and it is in NO column of the device row. This is the promise made at the paste box.
    const row = await database.db
      .selectFrom('runner_devices')
      .selectAll()
      .where('id', '=', runner.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(secret);
    // Nor is it in the container's environment, where `docker inspect` would print it back.
    expect(JSON.stringify(containers.get(runner.id)?.env)).not.toContain(secret);
  });

  it('provisions without any credential, leaving the slot to be filled later', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    expect(containers.get(runner.id)?.credentials).toEqual({});

    await service.updateProviderCredential(userId, 'claude-code', 'sk-ant-oat-later');
    expect(containers.get(runner.id)?.credentials['claude-code']).toBe('sk-ant-oat-later');
  });

  it('refuses a second cloud runner for the same user', async () => {
    const userId = await createUserWithGithub();
    await service.provision(userId, {});
    await expect(service.provision(userId, {})).rejects.toBeInstanceOf(errors.ConflictError);
  });

  it('refuses to provision for a user who has not connected GitHub', async () => {
    const userId = await createUser();
    await expect(service.provision(userId, {})).rejects.toBeInstanceOf(errors.NotFoundError);
    // Nothing was created on the way to that refusal.
    const rows = await database.db
      .selectFrom('runner_devices')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toEqual([]);
  });

  it('refuses to provision when the installation grants no repositories', async () => {
    const userId = await createUserWithGithub(0);
    await expect(service.provision(userId, {})).rejects.toBeInstanceOf(errors.ConflictError);
  });
});

// ---------------------------------------------------------------------------------------------
// Rollback. Each stage of provisioning is failed on purpose; nothing may survive any of them.
// ---------------------------------------------------------------------------------------------

describe('provision rollback', () => {
  /**
   * Nothing survives a failed provision: no device row for this user, and not one container more than
   * the provisioner held before the attempt. The container check is a set comparison rather than a
   * lookup by device id ON PURPOSE — after a correct rollback the id is gone from the database, so a
   * test that needed it to find the leak could not detect the leak it exists to detect.
   */
  async function expectNothingLeftBehind(userId: string, before: ReadonlySet<string>): Promise<void> {
    const rows = await database.db
      .selectFrom('runner_devices')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toEqual([]);
    expect([...containers.keys()].sort()).toEqual([...before].sort());
  }

  it('leaves no device row when the container cannot be created', async () => {
    const userId = await createUserWithGithub();
    const before = new Set(containers.keys());
    failOnce.add('POST /v1/runners');

    await expect(service.provision(userId, {})).rejects.toThrow(/provisioner POST \/v1\/runners failed/);
    await expectNothingLeftBehind(userId, before);
  });

  it('destroys the container when writing the credential fails', async () => {
    const userId = await createUserWithGithub();
    const before = new Set(containers.keys());
    failOnce.add('PUT /v1/runners/:id/credentials/claude-code');

    await expect(service.provision(userId, { 'claude-code': 'sk-ant-oat-doomed' })).rejects.toThrow(
      /provisioner PUT/,
    );

    await expectNothingLeftBehind(userId, before);
    // The container it had already created was explicitly destroyed — and its volumes were NOT removed,
    // because on an error path nothing of the user's is on them and that flag must never become a habit.
    expect(destroyed.at(-1)?.removeVolumes).toBe(false);
    expect(before.has(destroyed.at(-1)?.deviceId ?? '')).toBe(false);
  });

  it('destroys the container when it cannot be started', async () => {
    const userId = await createUserWithGithub();
    const before = new Set(containers.keys());
    failOnce.add('POST /v1/runners/:id/start');

    await expect(service.provision(userId, {})).rejects.toThrow(/provisioner POST/);
    await expectNothingLeftBehind(userId, before);
    expect(destroyed.at(-1)?.removeVolumes).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Lifecycle: start, stop, destroy, and revoke.
// ---------------------------------------------------------------------------------------------

describe('lifecycle', () => {
  it('stops and starts the container without touching its volumes', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});

    const stopped = await service.stop(userId);
    expect(stopped.containerStatus).toBe('stopped');
    expect(containers.get(runner.id)?.status).toBe('exited');
    expect(containers.get(runner.id)?.volumesRemoved).toBe(false);

    const started = await service.start(userId);
    expect(started.containerStatus).toBe('running');
    expect(containers.get(runner.id)?.status).toBe('running');
  });

  it('destroy removes the row, the container, and the volumes', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});

    await expect(service.destroy(userId)).resolves.toBe(true);

    expect(await deviceRow(runner.id)).toBeNull();
    expect(containers.has(runner.id)).toBe(false);
    expect(destroyed.at(-1)).toEqual({ deviceId: runner.id, removeVolumes: true });
    // A second destroy is not an error — there is simply nothing to destroy.
    await expect(service.destroy(userId)).resolves.toBe(false);
  });

  it('revoking a hosted device from the ordinary device list destroys its container too', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    const container = containers.get(runner.id);
    const deviceToken = container?.env['STEWRA_RUNNER_DEVICE_TOKEN'] ?? '';

    await expect(runners.revokeDevice(actor(userId),runner.id)).resolves.toBe(true);

    // The token died with the row — that is the security-relevant half, and it does not wait on Docker.
    await expect(runners.authenticateRunner(deviceToken)).resolves.toBeNull();
    expect(containers.has(runner.id)).toBe(false);
    expect(destroyed.at(-1)).toEqual({ deviceId: runner.id, removeVolumes: true });
  });

  it('revoking a LOCAL device asks the provisioner for nothing', async () => {
    const userId = await createUserWithGithub();
    const { deviceId } = await pairLocalDevice(userId);
    const destroyedBefore = destroyed.length;

    await expect(runners.revokeDevice(actor(userId),deviceId)).resolves.toBe(true);

    expect(destroyed.length).toBe(destroyedBefore);
  });

  it('reports 404 for lifecycle actions when the user has no cloud runner', async () => {
    const userId = await createUser();
    await expect(service.start(userId)).rejects.toBeInstanceOf(errors.NotFoundError);
    await expect(service.stop(userId)).rejects.toBeInstanceOf(errors.NotFoundError);
    await expect(service.updateProviderCredential(userId, 'claude-code', 'x')).rejects.toBeInstanceOf(
      errors.NotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The laptop invariant, over real HTTP through the real middleware chain.
// ---------------------------------------------------------------------------------------------

describe('runner-facing endpoints', () => {
  async function call(
    method: string,
    path: string,
    token: string | null,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('mints a git credential for a hosted runner', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    const token = containers.get(runner.id)?.env['STEWRA_RUNNER_DEVICE_TOKEN'] ?? '';

    const { status, body } = await call('POST', '/api/runner/git-credentials', token);

    expect(status).toBe(200);
    const data = body['data'] as { username: string; token: string; expiresAt: string };
    expect(data.username).toBe('x-access-token');
    expect(data.token).toMatch(/^ghs_/);
    // Short-lived by construction — nothing long-lived is ever handed to a container.
    expect(new Date(data.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 61 * 60 * 1000);
  });

  it('REFUSES a git credential to a runner on the user\'s own machine', async () => {
    const userId = await createUserWithGithub();
    const { token } = await pairLocalDevice(userId);

    const { status, body } = await call('POST', '/api/runner/git-credentials', token);

    expect(status).toBe(403);
    expect(JSON.stringify(body)).toContain('only available to Stewra-hosted runners');
  });

  it('refuses a git credential to a revoked, forged, or absent token', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    const token = containers.get(runner.id)?.env['STEWRA_RUNNER_DEVICE_TOKEN'] ?? '';
    await runners.revokeDevice(actor(userId),runner.id);

    expect((await call('POST', '/api/runner/git-credentials', token)).status).toBe(401);
    expect((await call('POST', '/api/runner/git-credentials', 'stwrn_forged')).status).toBe(401);
    expect((await call('POST', '/api/runner/git-credentials', null)).status).toBe(401);
  });

  it('serves the installation repositories as workspaces to a hosted runner only', async () => {
    const userId = await createUserWithGithub(3);
    const runner = await service.provision(userId, {});
    const hostedToken = containers.get(runner.id)?.env['STEWRA_RUNNER_DEVICE_TOKEN'] ?? '';
    const { token: localToken } = await pairLocalDevice(userId);

    const hosted = await call('GET', '/api/runner/hosted/workspaces', hostedToken);
    expect(hosted.status).toBe(200);
    const workspaces = (hosted.body['data'] as { workspaces: { id: string; cloneUrl: string }[] }).workspaces;
    expect(workspaces).toHaveLength(3);
    expect(workspaces[0]).toEqual({
      id: 'robin-org/repo-0',
      name: 'repo-0',
      cloneUrl: 'https://github.com/robin-org/repo-0.git',
      defaultBranch: 'main',
    });

    expect((await call('GET', '/api/runner/hosted/workspaces', localToken)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------
// Sweeps: reconciliation against Docker's truth, and idle-stop's choice of victims.
// ---------------------------------------------------------------------------------------------

describe('reconcile', () => {
  it('destroys a container whose device row is gone, volumes and all', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    // The shape a failed rollback leaves behind: the row deleted, the container still running.
    await deviceRepo.deleteById(runner.id);

    const result = await service.reconcile();

    expect(result.orphansDestroyed).toBeGreaterThanOrEqual(1);
    expect(containers.has(runner.id)).toBe(false);
    expect(destroyed.some((d) => d.deviceId === runner.id && d.removeVolumes)).toBe(true);
  });

  it('corrects a status that drifted from what Docker actually has', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    // What a host reboot looks like: Docker says exited, the row still claims running.
    const container = containers.get(runner.id);
    if (container === undefined) throw new Error('the scripted provisioner lost the container');
    container.status = 'exited';

    await service.reconcile();

    expect((await deviceRow(runner.id))?.container_status).toBe('stopped');
  });

  it('marks a device whose container has vanished as failed rather than deleting it', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    containers.delete(runner.id); // gone from Docker, but the user's volumes may still exist

    await service.reconcile();

    const row = await deviceRow(runner.id);
    expect(row).not.toBeNull();
    expect(row?.container_status).toBe('failed');
  });
});

describe('idleStop', () => {
  /** Age a runner's activity timestamps past the idle window without waiting an hour for it. */
  async function makeIdle(deviceId: string): Promise<void> {
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await database.db
      .updateTable('runner_devices')
      .set({ container_last_started_at: longAgo, last_seen_at: longAgo })
      .where('id', '=', deviceId)
      .execute();
  }

  it('stops an idle runner and leaves its volumes alone', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    await makeIdle(runner.id);

    const stopped = await service.idleStop();

    expect(stopped).toBeGreaterThanOrEqual(1);
    expect(containers.get(runner.id)?.status).toBe('exited');
    expect(containers.get(runner.id)?.volumesRemoved).toBe(false);
    expect((await deviceRow(runner.id))?.container_status).toBe('stopped');
  });

  it('leaves a freshly started runner alone', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});

    await service.idleStop();

    expect(containers.get(runner.id)?.status).toBe('running');
  });

  it('never stops a runner with a session still in flight', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    await makeIdle(runner.id);
    // An agent mid-run is silent on the socket; "no traffic" must never be read as "nothing happening".
    await database.db
      .insertInto('runner_sessions')
      .values({
        org_id: actor(userId).orgId,
        user_id: userId,
        device_id: runner.id,
        device_name: 'Stewra Cloud Runner',
        harness: 'claude-code',
        workspace_id: 'robin-org/repo-0',
        workspace_name: 'repo-0',
        status: 'running',
        prompt: 'a long refactor',
      })
      .execute();

    await service.idleStop();

    expect(containers.get(runner.id)?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------------------------
// Waking. A stopped cloud runner is Stewra's problem to solve, not the user's to be told about.
// ---------------------------------------------------------------------------------------------

describe('wakeAndAwait', () => {
  it('starts the container and reports honestly when it never connects', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    await service.stop(userId);

    // No socket namespace is mounted in this suite, so the runner can never say hello — which is
    // exactly the timeout path, and it must answer false rather than hang or throw.
    const woke = await service.wakeAndAwait(runner.id);

    expect(woke).toBe(false);
    // It DID start the container: the failure is "did not connect in time", not "did not try".
    expect(containers.get(runner.id)?.status).toBe('running');
  }, (WAKE_TIMEOUT_SECONDS + 15) * 1000);

  it('reports failure and marks the runner failed when the container cannot be started', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});
    await service.stop(userId);
    failOnce.add('POST /v1/runners/:id/start');

    await expect(service.wakeAndAwait(runner.id)).resolves.toBe(false);
    expect((await deviceRow(runner.id))?.container_status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------------------------
// Status, as the "Cloud Runner" card reads it.
// ---------------------------------------------------------------------------------------------

describe('getStatus', () => {
  it('reports the feature as available with no runner yet', async () => {
    const userId = await createUser();
    await expect(service.getStatus(userId)).resolves.toEqual({
      enabled: true,
      runner: null,
      idleStopMinutes: 60,
    });
  });

  it('reports the provisioned runner and the idle window it will be stopped after', async () => {
    const userId = await createUserWithGithub();
    const runner = await service.provision(userId, {});

    const status = await service.getStatus(userId);

    expect(status.enabled).toBe(true);
    expect(status.runner?.id).toBe(runner.id);
    expect(status.runner?.kind).toBe('hosted');
    expect(status.idleStopMinutes).toBe(60);
  });
});
