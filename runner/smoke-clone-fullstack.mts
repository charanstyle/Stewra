// Full-stack Phase 4 live driver: the SAME runner binary in cloud-VM mode. Instead of exposing a local
// checkout, the runner runs with STEWRA_RUNNER_WORKSPACE_MODE=clone and CLONE_REPOS pointed at a repo it
// must `git clone` itself — then a real session runs against that clone and its branch is pushed back to
// the origin, all through the REAL backend + web REST/socket surface. `origin` is a local repo (real git
// over a real transport, no network, no mocks) standing in for the GitHub repo a real VM would clone.
// Run AFTER the backend is up on :3999.  cd runner && npx tsx smoke-clone-fullstack.mts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { io as ioc } from 'socket.io-client';
import { loadRunnerConfig } from './src/config.js';
import { StewraRunnerClient } from './src/core/stewraRunnerClient.js';
import { detectHarnesses, detectWorkspaces } from './src/core/capabilities.js';
import type { RunnerHelloPayload } from '@stewra/shared-types';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd });
const BASE = process.env.BASE ?? 'http://127.0.0.1:3999';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.e2e');
const env = Object.fromEntries(
  (await readFile(ENV_PATH, 'utf8'))
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const EMAIL = env.E2E_USER_A_EMAIL;
const PASSWORD = env.E2E_USER_A_PASSWORD;

let failures = 0;
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  console.log(`\n== Runner Phase 4 cloud-VM (clone mode) full-stack driver (${BASE}) ==\n`);

  // The "GitHub" repo the runner will clone (a local repo — real git, no network).
  const origin = await mkdtemp(join(tmpdir(), 'stewra-clone-origin-'));
  await git(origin, ['init', '-q', '-b', 'main']);
  await git(origin, ['config', 'user.email', 'origin@stewra.local']);
  await git(origin, ['config', 'user.name', 'Stewra Origin']);
  await writeFile(join(origin, 'README.md'), '# cloud repo\n');
  await git(origin, ['add', '.']);
  await git(origin, ['commit', '-q', '-m', 'init']);
  const cloneRoot = await mkdtemp(join(tmpdir(), 'stewra-clone-root-'));
  console.log(`origin: ${origin}\nclone root: ${cloneRoot}`);

  // Cloud-VM configuration: NO local workspace dirs — the runner must clone the repo itself.
  process.env['STEWRA_API_URL'] = BASE;
  process.env['STEWRA_API_PREFIX'] = '';
  process.env['STEWRA_RUNNER_WORKSPACE_MODE'] = 'clone';
  process.env['STEWRA_RUNNER_CLONE_REPOS'] = origin;
  process.env['STEWRA_RUNNER_WORKSPACE_ROOT'] = cloneRoot;
  delete process.env['STEWRA_RUNNER_WORKSPACES'];
  process.env['STEWRA_RUNNER_ACP_CLAUDE_CODE'] = 'npx -y @agentclientprotocol/claude-agent-acp';

  const login = await api('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  const jwt = login.json?.data?.tokens?.accessToken;
  check('login', login.status === 200 && !!jwt);
  const pair = await api('POST', '/runner/pair', { token: jwt });
  const code = pair.json?.data?.code;
  check('pairing code minted', !!code);

  const config = loadRunnerConfig(process.env, '0.1.0');
  const client = new StewraRunnerClient(config);
  const token = await client.claimToken(code, 'phase4-clone-driver', process.platform);
  check('device token claimed', !!token);

  const helloProvider = async (): Promise<RunnerHelloPayload> => {
    const [harnesses, workspaces] = await Promise.all([detectHarnesses(), detectWorkspaces()]);
    return { appVersion: '0.1.0', os: process.platform, harnesses, workspaces };
  };
  let connected = false;
  client.connect(token, helloProvider, {
    onConnected: () => { connected = true; },
    onDisconnected: () => {},
    onRevoked: () => {},
  });

  // Wait for the device online with a CLONED workspace reported (remote + default branch set by clone).
  let deviceId: string | undefined;
  let workspaceId: string | undefined;
  let reportedRemote: string | undefined;
  let reportedBranch: string | undefined;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const devices = (await api('GET', '/runner/devices', { token: jwt })).json?.data?.devices ?? [];
    const d = devices.find((x: any) => x.online && x.name === 'phase4-clone-driver');
    if (d && d.workspaces.length > 0 && d.harnesses.some((h: any) => h.id === 'claude-code' && h.available)) {
      deviceId = d.id;
      workspaceId = d.workspaces[0].id;
      reportedRemote = d.workspaces[0].gitRemote;
      reportedBranch = d.workspaces[0].defaultBranch;
      break;
    }
  }
  check('runner online (connected)', connected);
  check('device + cloned workspace + claude-code reported', !!deviceId && !!workspaceId);
  check('reported workspace carries the origin remote', reportedRemote === origin);
  check('reported workspace default branch is main', reportedBranch === 'main');
  if (!deviceId || !workspaceId) throw new Error('runner never came online with a cloned workspace');

  // The runner really cloned the repo to disk (not just announced it). The clone dir is named after the
  // repo's tail — for a local origin path that's its basename.
  const clonedDir = join(cloneRoot, basename(origin));
  const clonedReadme = await stat(join(clonedDir, 'README.md')).then(() => true).catch(() => false);
  check('repo was really cloned to the workspace root', clonedReadme);

  const web = ioc(BASE, { path: '/socket.io', auth: { token: jwt }, transports: ['websocket'], reconnection: false });
  let donePayload: any = null;
  let sessionId: string | undefined;
  await new Promise<void>((res, rej) => {
    web.once('connect', () => res());
    web.once('connect_error', rej);
    setTimeout(() => rej(new Error('web socket connect timeout')), 8000);
  });
  web.on('runner-ui:session-done', (e: any) => { donePayload = e; });
  web.on('runner-ui:permission-request', (e: any) => {
    const opt = e.options.find((o: any) => o.kind === 'allow_always') ?? e.options.find((o: any) => o.kind === 'allow_once') ?? e.options[0];
    console.log(`     [permission] "${e.title}" -> allow "${opt?.label}"`);
    if (sessionId) void api('POST', `/runner/sessions/${sessionId}/permission`, { token: jwt, body: { promptId: e.promptId, optionId: opt.id } });
  });

  const start = await api('POST', '/runner/sessions', {
    token: jwt,
    body: {
      deviceId,
      harness: 'claude-code',
      workspaceId,
      prompt: "Create a file named cloud.txt in the current directory containing exactly 'Built on a cloud runner'. Use your file-writing tool, then briefly confirm and stop.",
    },
  });
  sessionId = start.json?.data?.session?.id;
  check('session started (status running)', start.json?.data?.session?.status === 'running' && !!sessionId);

  for (let i = 0; i < 240 && donePayload === null; i += 1) await sleep(500);
  check('session-done received', donePayload !== null);
  check('session completed', donePayload?.status === 'completed');
  check('done payload committed=true', donePayload?.committed === true);
  const branch: string = donePayload?.branch ?? '';
  check('done payload carries a branch', branch.length > 0);

  // Push the session branch back to the origin ("GitHub") through the REST surface.
  console.log('\n  pushing the session branch back to origin via POST /runner/sessions/:id/push …');
  const push = await api('POST', `/runner/sessions/${sessionId}/push`, { token: jwt, body: {} });
  check('push endpoint 200', push.status === 200);
  check('push returned the origin remote url', push.json?.data?.remoteUrl === origin);

  const { stdout: ls } = await execFileAsync('git', ['ls-remote', '--heads', origin, branch]);
  check('session branch landed back on origin', ls.includes(`refs/heads/${branch}`));

  // Origin's own working tree (its main checkout) is untouched — the change lives only on the pushed branch.
  const leaked = await stat(join(origin, 'cloud.txt')).then(() => true).catch(() => false);
  check('origin main checkout untouched (change is on the branch only)', !leaked);

  console.log(`\n== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ==\n`);

  web.disconnect();
  client.disconnect();
  await api('DELETE', `/runner/devices/${deviceId}`, { token: jwt }).catch(() => undefined);
  await rm(origin, { recursive: true, force: true }).catch(() => undefined);
  await rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\nDRIVER ERROR:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
