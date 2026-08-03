import { generateKeyPairSync, randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
// Type-only, so they are erased and do NOT load these modules here — the graph is still imported
// dynamically below, after this file has set the environment the config reads at module load.
import type * as errorTypes from '../utils/errors.js';
import type { db, closeDb } from '../database/index.js';
import type { githubAppService } from '../services/githubAppService.js';

/**
 * The Stewra GitHub App integration, end to end and with nothing stood in for.
 *
 * The chain under test is what lets a hosted runner touch a user's repositories: install URL with a
 * signed state → GitHub redirects back → link verifies the state AND the installation against GitHub
 * → short-lived installation tokens minted on demand, cached in memory, never at rest. Every claim
 * here — "the state binds the callback to the user", "a dead installation clears the row", "tokens
 * are reused only while they have life left" — is a claim about real rows and real HTTP exchanges.
 *
 * Everything runs against the real `stewra_test` Postgres and a real HTTP server standing where
 * GitHub's API does. That server is scripted, not mocked: it VERIFIES each App JWT against the RSA
 * public key (RS256, issuer, GitHub's own 10-minute lifetime rule) and refuses bad auth exactly as
 * GitHub would — so a regression in the signing path fails these tests instead of production.
 */

const APP_ID = '31337';
const APP_SLUG = 'stewra-dev';

// The App's real credential shape: an RSA keypair, private half handed to the config base64-wrapped
// exactly as a deploy does it, public half held by the scripted GitHub to verify what we sign.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

// ---------------------------------------------------------------------------------------------
// The scripted GitHub. Real HTTP, real JWT verification, state the tests can inspect and mutate.
// ---------------------------------------------------------------------------------------------

interface FakeRepo {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
}

interface FakeInstallation {
  accountLogin: string;
  repos: FakeRepo[];
  /** How long the tokens this installation mints live — short values force re-mints past the cache. */
  tokenTtlMs: number;
}

const installations = new Map<number, FakeInstallation>();
/** Every authentication failure, with a reason — asserted empty after every test. */
const badAuth: string[] = [];
const mintCounts = new Map<number, number>();
/** token → installation it belongs to, so the repositories endpoint can authenticate like GitHub. */
const mintedTokens = new Map<string, number>();
const deletedIds: number[] = [];
let failDeleteOnce = false;

/** Register an installation under a fresh, run-unique id (leftover rows from prior runs persist). */
function addInstallation(opts?: {
  repoCount?: number;
  tokenTtlMs?: number;
  accountLogin?: string;
}): number {
  const id = randomInt(1_000_000, 2_000_000_000);
  const repoCount = opts?.repoCount ?? 2;
  const repos: FakeRepo[] = [];
  for (let i = 0; i < repoCount; i += 1) {
    repos.push({
      full_name: `robin-org/repo-${i}`,
      clone_url: `https://github.com/robin-org/repo-${i}.git`,
      default_branch: 'main',
      private: i % 2 === 0,
    });
  }
  installations.set(id, {
    accountLogin: opts?.accountLogin ?? 'robin-org',
    repos,
    tokenTtlMs: opts?.tokenTtlMs ?? 60 * 60 * 1000,
  });
  return id;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Verify a Bearer App JWT the way GitHub does: RS256 against the App's key, issuer, ≤10 min life. */
function verifyAppJwt(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  try {
    const payload = jwt.verify(token, PUBLIC_PEM, { algorithms: ['RS256'] }) as jwt.JwtPayload;
    if (payload.iss !== APP_ID) {
      badAuth.push(`app jwt issuer ${String(payload.iss)} is not the App id`);
      return false;
    }
    if (payload.exp !== undefined && payload.iat !== undefined && payload.exp - payload.iat > 600) {
      badAuth.push('app jwt lifetime exceeds the 10 minutes GitHub allows');
      return false;
    }
    return true;
  } catch (error) {
    badAuth.push(`app jwt rejected: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://github.invalid');

  const tokenMint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
  if (tokenMint !== null && req.method === 'POST') {
    if (!verifyAppJwt(req)) return json(res, 401, { message: 'Bad credentials' });
    const id = Number(tokenMint[1]);
    const installation = installations.get(id);
    if (installation === undefined) return json(res, 404, { message: 'Not Found' });
    const count = (mintCounts.get(id) ?? 0) + 1;
    mintCounts.set(id, count);
    const token = `ghs_${id}_${count}`;
    mintedTokens.set(token, id);
    return json(res, 201, {
      token,
      expires_at: new Date(Date.now() + installation.tokenTtlMs).toISOString(),
    });
  }

  const byId = /^\/app\/installations\/(\d+)$/.exec(url.pathname);
  if (byId !== null && req.method === 'GET') {
    if (!verifyAppJwt(req)) return json(res, 401, { message: 'Bad credentials' });
    const id = Number(byId[1]);
    const installation = installations.get(id);
    if (installation === undefined) return json(res, 404, { message: 'Not Found' });
    return json(res, 200, { id, account: { login: installation.accountLogin } });
  }
  if (byId !== null && req.method === 'DELETE') {
    if (!verifyAppJwt(req)) return json(res, 401, { message: 'Bad credentials' });
    const id = Number(byId[1]);
    deletedIds.push(id);
    if (failDeleteOnce) {
      failDeleteOnce = false;
      return json(res, 500, { message: 'GitHub is having a moment' });
    }
    installations.delete(id);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/installation/repositories' && req.method === 'GET') {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const id = mintedTokens.get(token);
    const installation = id === undefined ? undefined : installations.get(id);
    if (installation === undefined) {
      badAuth.push('repositories called without a live installation token');
      return json(res, 401, { message: 'Bad credentials' });
    }
    const perPage = Number(url.searchParams.get('per_page') ?? '30');
    const page = Number(url.searchParams.get('page') ?? '1');
    return json(res, 200, {
      total_count: installation.repos.length,
      repositories: installation.repos.slice((page - 1) * perPage, page * perPage),
    });
  }

  badAuth.push(`unexpected request ${req.method ?? '?'} ${url.pathname}`);
  json(res, 500, { message: 'the scripted GitHub has no such route' });
}

const github = createServer((req, res) => route(req, res));
await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
const GITHUB_URL = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

// ---------------------------------------------------------------------------------------------
// Config, from the environment, exactly as a deploy does it — pinned before the graph is imported.
// ---------------------------------------------------------------------------------------------

interface Graph {
  readonly service: typeof githubAppService;
  readonly errors: typeof errorTypes;
  readonly db: typeof db;
  readonly closeDb: typeof closeDb;
}

async function loadGraph(configured: boolean): Promise<Graph> {
  if (configured) {
    process.env['GITHUB_APP_ID'] = APP_ID;
    process.env['GITHUB_APP_SLUG'] = APP_SLUG;
    process.env['GITHUB_APP_PRIVATE_KEY_BASE64'] = Buffer.from(PRIVATE_PEM).toString('base64');
    process.env['GITHUB_API_BASE_URL'] = GITHUB_URL;
  } else {
    delete process.env['GITHUB_APP_ID'];
    delete process.env['GITHUB_APP_SLUG'];
    delete process.env['GITHUB_APP_PRIVATE_KEY_BASE64'];
  }
  vi.resetModules();
  const { githubAppService } = await import('../services/githubAppService.js');
  const errors = await import('../utils/errors.js');
  const database = await import('../database/index.js');
  return { service: githubAppService, errors, db: database.db, closeDb: database.closeDb };
}

const on = await loadGraph(true);
// A second, independently-configured copy of the application with no App configured — a deploy
// without the feature is a different process, not a mutated field.
const off = await loadGraph(false);

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];

async function createUser(): Promise<string> {
  const row = await on.db
    .insertInto('users')
    .values({
      email: `github-app-${randomUUID()}@stewra.invalid`,
      display_name: 'GitHub App Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

/** The state a real callback carries: minted by the service itself, lifted out of the install URL. */
function freshState(userId: string): string {
  const state = new URL(on.service.getInstallUrl(userId)).searchParams.get('state');
  if (state === null) throw new Error('the install URL carries no state');
  return state;
}

async function installationRow(userId: string): Promise<{ installationId: number } | null> {
  const row = await on.db
    .selectFrom('github_app_installations')
    .select('installation_id')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row === undefined ? null : { installationId: Number(row.installation_id) };
}

afterEach(() => {
  // The scripted GitHub refused something the service sent. Whatever the test was, THIS is the bug.
  expect(badAuth).toEqual([]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => github.close(() => resolve()));

  // Users that gained an audit row cannot be deleted (audit_log is append-only, ON DELETE SET NULL
  // is rejected by its trigger), so their installation rows would linger — clear those explicitly.
  if (createdUsers.length > 0) {
    await on.db.deleteFrom('github_app_installations').where('user_id', 'in', createdUsers).execute();
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
// The install URL: where the user is sent, and the state that ties the round trip to them.
// ---------------------------------------------------------------------------------------------

describe('getInstallUrl', () => {
  it('points at the App install page with a state naming exactly this user', async () => {
    const userId = await createUser();
    const url = new URL(on.service.getInstallUrl(userId));

    expect(url.origin + url.pathname).toBe(`https://github.com/apps/${APP_SLUG}/installations/new`);

    // The state is verifiable with the server's own auth secret and subjects the user — the whole
    // point is that the credential-less callback cannot be replayed onto someone else's account.
    const state = url.searchParams.get('state');
    expect(state).not.toBeNull();
    const jwtSecret = process.env['JWT_SECRET'];
    if (jwtSecret === undefined) throw new Error('JWT_SECRET is not set in the test environment');
    const decoded = jwt.verify(state as string, jwtSecret) as jwt.JwtPayload;
    expect(decoded.sub).toBe(userId);
    expect((decoded.exp ?? 0) * 1000).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------------------------
// Linking: the callback's installation id is only believed after GitHub confirms it.
// ---------------------------------------------------------------------------------------------

describe('linkInstallation', () => {
  it('verifies the state, confirms the installation with GitHub, stores the row, and audits', async () => {
    const userId = await createUser();
    const installationId = addInstallation({ repoCount: 2 });

    const result = await on.service.linkInstallation(userId, installationId, freshState(userId));
    expect(result.accountLogin).toBe('robin-org');
    expect(result.repos).toEqual([
      {
        fullName: 'robin-org/repo-0',
        cloneUrl: 'https://github.com/robin-org/repo-0.git',
        defaultBranch: 'main',
        private: true,
      },
      {
        fullName: 'robin-org/repo-1',
        cloneUrl: 'https://github.com/robin-org/repo-1.git',
        defaultBranch: 'main',
        private: false,
      },
    ]);

    // The row is real, and holds no credential — an id and a login, nothing mintable.
    await expect(installationRow(userId)).resolves.toEqual({ installationId });

    // Granting repository access to a code-running service is audited.
    const audit = await on.db
      .selectFrom('audit_log')
      .select(['action', 'summary'])
      .where('user_id', '=', userId)
      .execute();
    expect(audit.some((a) => a.action === 'connect' && a.summary.includes('GitHub'))).toBe(true);
  });

  it('refuses a forged state, and a genuine state that belongs to a different user', async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const installationId = addInstallation();

    await expect(
      on.service.linkInstallation(owner, installationId, 'not-a-jwt-at-all'),
    ).rejects.toBeInstanceOf(on.errors.AuthenticationError);

    // A state really minted by the service — for someone else. Possession is not enough.
    await expect(
      on.service.linkInstallation(intruder, installationId, freshState(owner)),
    ).rejects.toBeInstanceOf(on.errors.AuthenticationError);

    await expect(installationRow(owner)).resolves.toBeNull();
    await expect(installationRow(intruder)).resolves.toBeNull();
  });

  it('refuses an installation id GitHub does not recognise, before storing anything', async () => {
    const userId = await createUser();
    await expect(
      on.service.linkInstallation(userId, 999_999_999, freshState(userId)),
    ).rejects.toBeInstanceOf(on.errors.NotFoundError);
    await expect(installationRow(userId)).resolves.toBeNull();
  });

  it("refuses to claim an installation already linked to another user's account", async () => {
    const first = await createUser();
    const second = await createUser();
    const installationId = addInstallation();

    await on.service.linkInstallation(first, installationId, freshState(first));
    await expect(
      on.service.linkInstallation(second, installationId, freshState(second)),
    ).rejects.toBeInstanceOf(on.errors.ConflictError);

    // The original link is untouched; the claimant got nothing.
    await expect(installationRow(first)).resolves.toEqual({ installationId });
    await expect(installationRow(second)).resolves.toBeNull();
  });

  it('replaces the previous link when the user re-runs the install flow', async () => {
    const userId = await createUser();
    const firstInstall = addInstallation();
    const secondInstall = addInstallation({ accountLogin: 'robin-other-org' });

    await on.service.linkInstallation(userId, firstInstall, freshState(userId));
    const result = await on.service.linkInstallation(userId, secondInstall, freshState(userId));
    expect(result.accountLogin).toBe('robin-other-org');

    // One row per user: the newest click-through is the user's current intent.
    await expect(installationRow(userId)).resolves.toEqual({ installationId: secondInstall });
  });
});

// ---------------------------------------------------------------------------------------------
// Status: what the setup UI renders, in every configuration.
// ---------------------------------------------------------------------------------------------

describe('getStatus', () => {
  it('reports not-installed with an install URL before linking, and the repos after', async () => {
    const userId = await createUser();

    const before = await on.service.getStatus(userId);
    expect(before).toMatchObject({ configured: true, installed: false, accountLogin: null, repos: [] });
    expect(before.installUrl).toContain(`/apps/${APP_SLUG}/`);

    const installationId = addInstallation({ repoCount: 1 });
    await on.service.linkInstallation(userId, installationId, freshState(userId));

    const after = await on.service.getStatus(userId);
    expect(after.installed).toBe(true);
    expect(after.accountLogin).toBe('robin-org');
    expect(after.repos.map((r) => r.fullName)).toEqual(['robin-org/repo-0']);
  });
});

// ---------------------------------------------------------------------------------------------
// Installation tokens: the only git credential hosted mode ever produces.
// ---------------------------------------------------------------------------------------------

describe('mintInstallationToken', () => {
  it('mints a live token, and reuses it from memory while it still has life left', async () => {
    const userId = await createUser();
    const installationId = addInstallation();
    await on.service.linkInstallation(userId, installationId, freshState(userId));
    const mintsAfterLink = mintCounts.get(installationId) ?? 0; // linking lists repos, which minted once

    const first = await on.service.mintInstallationToken(userId);
    const second = await on.service.mintInstallationToken(userId);
    expect(first.token).toBe(second.token);
    expect(first.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Both calls were served by the cache — GitHub saw no new mint.
    expect(mintCounts.get(installationId)).toBe(mintsAfterLink);
  });

  it('re-mints instead of handing out a token too close to its expiry', async () => {
    const userId = await createUser();
    // Five-minute tokens: always inside the ten-minute reuse margin, so the cache must never serve.
    const installationId = addInstallation({ tokenTtlMs: 5 * 60 * 1000 });
    await on.service.linkInstallation(userId, installationId, freshState(userId));

    const first = await on.service.mintInstallationToken(userId);
    const second = await on.service.mintInstallationToken(userId);
    // A token about to die mid-git-operation is worse than a fresh mint.
    expect(second.token).not.toBe(first.token);
  });

  it('detects an uninstall lazily: a 404 from GitHub clears the stale link', async () => {
    const userId = await createUser();
    // Short-lived tokens so the next mint is forced past the cache and actually asks GitHub.
    const installationId = addInstallation({ tokenTtlMs: 5 * 60 * 1000 });
    await on.service.linkInstallation(userId, installationId, freshState(userId));

    // The user uninstalls the App on GitHub's side. Stewra hears nothing — until the next mint.
    installations.delete(installationId);

    await expect(on.service.mintInstallationToken(userId)).rejects.toBeInstanceOf(
      on.errors.NotFoundError,
    );
    // The dead link is gone, so the UI says "reconnect GitHub" instead of erroring forever.
    await expect(installationRow(userId)).resolves.toBeNull();
    const status = await on.service.getStatus(userId);
    expect(status.installed).toBe(false);
  });

  it('refuses when GitHub was never connected', async () => {
    const userId = await createUser();
    await expect(on.service.mintInstallationToken(userId)).rejects.toBeInstanceOf(
      on.errors.NotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Repository listing pages at 100 — a large installation must not be silently truncated.
// ---------------------------------------------------------------------------------------------

describe('listRepos', () => {
  it('walks every page of a >100-repo installation', async () => {
    const userId = await createUser();
    const installationId = addInstallation({ repoCount: 250 });
    const result = await on.service.linkInstallation(userId, installationId, freshState(userId));

    expect(result.repos).toHaveLength(250);
    // Order preserved across page boundaries — the last repo of page 3 is really repo 249.
    expect(result.repos[249]?.fullName).toBe('robin-org/repo-249');
  });
});

// ---------------------------------------------------------------------------------------------
// Unlinking: the user's forget must always win, whatever GitHub is doing.
// ---------------------------------------------------------------------------------------------

describe('unlink', () => {
  it('deletes the installation on GitHub, drops the row, and audits the disconnect', async () => {
    const userId = await createUser();
    const installationId = addInstallation();
    await on.service.linkInstallation(userId, installationId, freshState(userId));

    await on.service.unlink(userId);

    expect(deletedIds).toContain(installationId);
    await expect(installationRow(userId)).resolves.toBeNull();
    const audit = await on.db
      .selectFrom('audit_log')
      .select(['action', 'summary'])
      .where('user_id', '=', userId)
      .execute();
    expect(audit.some((a) => a.action === 'disconnect' && a.summary.includes('GitHub'))).toBe(true);
  });

  it('still forgets the link when GitHub errors on the delete', async () => {
    const userId = await createUser();
    const installationId = addInstallation();
    await on.service.linkInstallation(userId, installationId, freshState(userId));

    failDeleteOnce = true;
    await on.service.unlink(userId);

    // The user asked Stewra to forget; a GitHub hiccup must not pin the row.
    await expect(installationRow(userId)).resolves.toBeNull();
  });

  it('is a quiet no-op when nothing is linked', async () => {
    const userId = await createUser();
    await expect(on.service.unlink(userId)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// A deploy with no App configured has no GitHub surface at all — and says so, loudly.
// ---------------------------------------------------------------------------------------------

describe('with no GITHUB_APP_* configured', () => {
  it('reports itself unconfigured and refuses every operation that would need the App', async () => {
    const userId = await createUser();

    // The one deliberate exception: status must be able to SAY "not configured".
    await expect(off.service.getStatus(userId)).resolves.toEqual({
      configured: false,
      installed: false,
      accountLogin: null,
      installUrl: null,
      repos: [],
    });

    expect(() => off.service.getInstallUrl(userId)).toThrow(off.errors.ServiceUnavailableError);
    await expect(off.service.linkInstallation(userId, 1, 'state')).rejects.toBeInstanceOf(
      off.errors.ServiceUnavailableError,
    );
    await expect(off.service.mintInstallationToken(userId)).rejects.toBeInstanceOf(
      off.errors.ServiceUnavailableError,
    );
  });

  it('refuses to BOOT when the App is half-configured — operator error, caught at the door', async () => {
    // Only the id, no slug and no key: the exact typo'd-env-file shape the config guard exists for.
    process.env['GITHUB_APP_ID'] = APP_ID;
    delete process.env['GITHUB_APP_SLUG'];
    delete process.env['GITHUB_APP_PRIVATE_KEY_BASE64'];
    vi.resetModules();
    await expect(import('../config/unifiedConfig.js')).rejects.toThrow(
      /GitHub App configuration is incomplete/,
    );

    // A key that is not a PEM is refused at boot too, not at the first token mint.
    process.env['GITHUB_APP_SLUG'] = APP_SLUG;
    process.env['GITHUB_APP_PRIVATE_KEY_BASE64'] = Buffer.from('not a pem').toString('base64');
    vi.resetModules();
    await expect(import('../config/unifiedConfig.js')).rejects.toThrow(/PEM/);

    delete process.env['GITHUB_APP_ID'];
    delete process.env['GITHUB_APP_SLUG'];
    delete process.env['GITHUB_APP_PRIVATE_KEY_BASE64'];
  });
});
