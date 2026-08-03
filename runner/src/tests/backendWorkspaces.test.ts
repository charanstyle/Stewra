import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { detectWorkspaces } from '../core/capabilities.js';
import { loadRunnerConfig } from '../config.js';
import type { RunnerConfig } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * `WORKSPACE_MODE=backend`: a Stewra-hosted runner asking the backend which repositories it should be
 * running against, then cloning them.
 *
 * Real git repositories over `file://` URLs and a real HTTP server, rather than stubs. What this needs to
 * prove is that a list from the backend becomes usable checkouts on disk with the right base branch — and
 * a stubbed clone would assert only that the stub was called.
 */
describe('backend-supplied workspaces (hosted runners)', () => {
  let server: Server;
  let config: RunnerConfig;
  let scratch: string;
  let workspaceRoot: string;
  let respond: (res: ServerResponse) => void;
  let requests: string[];

  const DEVICE_TOKEN = 'device-token-for-this-container';
  const saved = {
    mode: process.env['STEWRA_RUNNER_WORKSPACE_MODE'],
    root: process.env['STEWRA_RUNNER_WORKSPACE_ROOT'],
  };

  /** A real bare repository with one commit on `trunk`, serving as an origin over file://. */
  async function makeOriginRepo(name: string, branch = 'trunk'): Promise<string> {
    const work = join(scratch, `${name}-work`);
    const bare = join(scratch, `${name}.git`);
    await execFileAsync('git', ['init', '-q', '--bare', '-b', branch, bare]);
    await execFileAsync('git', ['init', '-q', '-b', branch, work]);
    await execFileAsync('git', ['-C', work, 'config', 'user.email', 'test@stewra.local']);
    await execFileAsync('git', ['-C', work, 'config', 'user.name', 'Stewra Test']);
    await writeFile(join(work, 'README.md'), `${name}\n`);
    await execFileAsync('git', ['-C', work, 'add', '.']);
    await execFileAsync('git', ['-C', work, 'commit', '-q', '-m', 'initial']);
    await execFileAsync('git', ['-C', work, 'remote', 'add', 'origin', bare]);
    await execFileAsync('git', ['-C', work, 'push', '-q', 'origin', branch]);
    // Set origin/HEAD on the bare repo so a clone can resolve the default branch the way GitHub's does.
    await execFileAsync('git', ['-C', bare, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    return `file://${bare}`;
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(`${req.method ?? ''} ${req.url ?? ''}`);
      if (req.headers.authorization !== `Bearer ${DEVICE_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'That runner token is not valid.' }));
        return;
      }
      respond(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
    config = loadRunnerConfig(
      { STEWRA_API_URL: `http://127.0.0.1:${address.port}`, STEWRA_API_PREFIX: '' },
      '0.2.0',
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    requests = [];
    scratch = await mkdtemp(join(tmpdir(), 'stewra-backendws-'));
    workspaceRoot = join(scratch, 'workspaces');
    process.env['STEWRA_RUNNER_WORKSPACE_MODE'] = 'backend';
    process.env['STEWRA_RUNNER_WORKSPACE_ROOT'] = workspaceRoot;
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['STEWRA_RUNNER_WORKSPACE_MODE', saved.mode],
      ['STEWRA_RUNNER_WORKSPACE_ROOT', saved.root],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  });

  /** Serve a workspace list from the backend. */
  function serveWorkspaces(workspaces: readonly Record<string, string>[]): void {
    respond = (res): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { workspaces } }));
    };
  }

  it('clones every repository the backend names, and reports them as usable workspaces', async () => {
    const alpha = await makeOriginRepo('alpha');
    const beta = await makeOriginRepo('beta', 'develop');
    serveWorkspaces([
      { id: 'acme/alpha', name: 'alpha', cloneUrl: alpha, defaultBranch: 'trunk' },
      { id: 'acme/beta', name: 'beta', cloneUrl: beta, defaultBranch: 'develop' },
    ]);

    const workspaces = await detectWorkspaces({ config, token: DEVICE_TOKEN });

    expect(requests).toEqual(['GET /runner/hosted/workspaces']);
    expect(workspaces).toHaveLength(2);
    // The id is the backend's `owner/name`, not a path hash: it survives the container being rebuilt
    // onto a different directory layout, and it is what the user sees named in the app.
    expect(workspaces.map((w) => w.id)).toEqual(['acme/alpha', 'acme/beta']);
    // The repositories are genuinely on disk — the content came through, not just a directory.
    expect(await readFile(join(workspaces[0]!.path, 'README.md'), 'utf8')).toBe('alpha\n');
    expect(await readFile(join(workspaces[1]!.path, 'README.md'), 'utf8')).toBe('beta\n');
    // Enriched from the clone itself rather than echoed back from the request: a session branches from
    // this, so it has to be what git actually thinks the default branch is.
    expect(workspaces[0]?.defaultBranch).toBe('trunk');
    expect(workspaces[1]?.defaultBranch).toBe('develop');
    expect(workspaces[0]?.gitRemote).toBe(alpha);
  });

  it('keeps two repositories with the same name apart on disk', async () => {
    // Two owners' `api` repos, or a fork and its upstream. Colliding on one directory would silently
    // make them a single workspace, and a session would run against the wrong code.
    const ours = await makeOriginRepo('api');
    const theirs = await makeOriginRepo('api-fork');
    serveWorkspaces([
      { id: 'acme/api', name: 'api', cloneUrl: ours, defaultBranch: 'trunk' },
      { id: 'other/api', name: 'api', cloneUrl: theirs, defaultBranch: 'trunk' },
    ]);

    const workspaces = await detectWorkspaces({ config, token: DEVICE_TOKEN });

    expect(workspaces).toHaveLength(2);
    expect(workspaces[0]?.path).not.toBe(workspaces[1]?.path);
    expect(await readFile(join(workspaces[0]!.path, 'README.md'), 'utf8')).toBe('api\n');
    expect(await readFile(join(workspaces[1]!.path, 'README.md'), 'utf8')).toBe('api-fork\n');
  });

  it('picks up new commits on a later boot instead of serving a stale checkout', async () => {
    const alpha = await makeOriginRepo('alpha');
    serveWorkspaces([{ id: 'acme/alpha', name: 'alpha', cloneUrl: alpha, defaultBranch: 'trunk' }]);
    await detectWorkspaces({ config, token: DEVICE_TOKEN });

    // Someone pushes upstream while the container is stopped.
    const work = join(scratch, 'alpha-work');
    await writeFile(join(work, 'README.md'), 'alpha updated\n');
    await execFileAsync('git', ['-C', work, 'commit', '-qam', 'update']);
    await execFileAsync('git', ['-C', work, 'push', '-q', 'origin', 'trunk']);

    const workspaces = await detectWorkspaces({ config, token: DEVICE_TOKEN });

    const fetched = await execFileAsync('git', ['-C', workspaces[0]!.path, 'log', '-1', '--format=%s', 'origin/trunk']);
    expect(fetched.stdout.trim()).toBe('update');
  });

  it('keeps the other repositories when one cannot be cloned', async () => {
    const alpha = await makeOriginRepo('alpha');
    serveWorkspaces([
      { id: 'acme/gone', name: 'gone', cloneUrl: `file://${join(scratch, 'does-not-exist.git')}`, defaultBranch: 'trunk' },
      { id: 'acme/alpha', name: 'alpha', cloneUrl: alpha, defaultBranch: 'trunk' },
    ]);

    const workspaces = await detectWorkspaces({ config, token: DEVICE_TOKEN });

    // One unreachable repo must not cost the user every other one.
    expect(workspaces.map((w) => w.id)).toEqual(['acme/alpha']);
  });

  it('reports no workspaces when the installation covers no repositories', async () => {
    serveWorkspaces([]);

    await expect(detectWorkspaces({ config, token: DEVICE_TOKEN })).resolves.toEqual([]);
  });

  it('fails rather than reporting an empty list when the backend cannot be reached', async () => {
    // The distinction that matters: "your GitHub App covers no repositories" is a thing for the user to
    // go fix, and "Stewra is unreachable" is a fault to retry. Reported as the same empty list, the user
    // would go looking in the wrong place.
    respond = (res): void => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Something went wrong on our end.' }));
    };

    await expect(detectWorkspaces({ config, token: DEVICE_TOKEN })).rejects.toThrow(/Something went wrong/);
  });

  it('refuses a token the backend rejects, rather than silently running with no repositories', async () => {
    serveWorkspaces([]);

    await expect(detectWorkspaces({ config, token: 'a-revoked-token' })).rejects.toThrow(/not valid/);
  });

  it('refuses to start in backend mode with no device token at all', async () => {
    // There are no local checkouts to fall back to, and reporting zero workspaces would look to the user
    // exactly like an empty GitHub installation.
    await expect(detectWorkspaces()).rejects.toThrow(/requires a device token/);
    expect(requests).toHaveLength(0);
  });
});
