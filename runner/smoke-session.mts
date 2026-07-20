// Full-stack Phase 2 live driver. Drives the REAL runner client + session manager + ACP client through the
// REAL backend and the REAL web REST/socket surface: login -> pair -> connect+hello -> start a session ->
// watch the streamed output -> auto-approve the permission -> assert a real file edit landed in the
// session's isolated worktree. Run AFTER the backend is up on :3999 with migration 034 applied.
//   cd runner && npx tsx smoke-session.mts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
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

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
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
  console.log(`\n== Runner Phase 2 full-stack live driver (${BASE}) ==\n`);

  // A throwaway repo the runner will expose as a workspace.
  const repo = await mkdtemp(join(tmpdir(), 'stewra-sess-repo-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'sess@stewra.local']);
  await git(repo, ['config', 'user.name', 'Stewra Session']);
  await writeFile(join(repo, 'README.md'), '# demo\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  console.log(`repo: ${repo}`);

  // Point the runner at the raw local backend (root paths, not the /api proxy) and at the throwaway repo.
  process.env['STEWRA_API_URL'] = BASE;
  process.env['STEWRA_API_PREFIX'] = '';
  process.env['STEWRA_RUNNER_WORKSPACES'] = repo;
  process.env['STEWRA_RUNNER_ACP_CLAUDE_CODE'] = 'npx -y @agentclientprotocol/claude-agent-acp';

  // 1) Login (root path) + mint a pairing code.
  const login = await api('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  const jwt = login.json?.data?.tokens?.accessToken;
  check('login', login.status === 200 && !!jwt);
  const pair = await api('POST', '/runner/pair', { token: jwt });
  const code = pair.json?.data?.code;
  check('pairing code minted', !!code);

  // 2) Bring up a REAL runner: claim the token and connect (hosts sessions via the real SessionManager).
  const config = loadRunnerConfig(process.env, '0.1.0');
  const client = new StewraRunnerClient(config);
  const token = await client.claimToken(code, 'phase2-driver', process.platform);
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

  // 3) Wait for the device to be online with its workspace + harness reported.
  let deviceId: string | undefined;
  let workspaceId: string | undefined;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    const devices = (await api('GET', '/runner/devices', { token: jwt })).json?.data?.devices ?? [];
    const d = devices.find((x: any) => x.online && x.name === 'phase2-driver');
    if (d && d.workspaces.length > 0 && d.harnesses.some((h: any) => h.id === 'claude-code' && h.available)) {
      deviceId = d.id;
      workspaceId = d.workspaces[0].id;
      break;
    }
  }
  check('runner online (connected)', connected);
  check('device + workspace + claude-code reported', !!deviceId && !!workspaceId);
  if (!deviceId || !workspaceId) throw new Error('runner never came online with a usable workspace');

  // 4) Web side: subscribe to the live session stream over the MAIN namespace, as the web app does.
  const web = ioc(BASE, { path: '/socket.io', auth: { token: jwt }, transports: ['websocket'], reconnection: false });
  const updates: any[] = [];
  let donePayload: any = null;
  let permissionSeen = false;
  await new Promise<void>((res, rej) => {
    web.once('connect', () => res());
    web.once('connect_error', rej);
    setTimeout(() => rej(new Error('web socket connect timeout')), 8000);
  });
  web.on('runner-ui:session-update', (e: any) => updates.push(e));
  web.on('runner-ui:session-done', (e: any) => { donePayload = e; });

  let sessionId: string | undefined;
  web.on('runner-ui:permission-request', (e: any) => {
    permissionSeen = true;
    const opt = e.options.find((o: any) => o.kind === 'allow_always') ?? e.options.find((o: any) => o.kind === 'allow_once') ?? e.options[0];
    console.log(`     [permission] "${e.title}" -> allow "${opt?.label}"`);
    if (sessionId) void api('POST', `/runner/sessions/${sessionId}/permission`, { token: jwt, body: { promptId: e.promptId, optionId: opt.id } });
  });

  // 5) Start the session from the web REST surface.
  const start = await api('POST', '/runner/sessions', {
    token: jwt,
    body: {
      deviceId,
      harness: 'claude-code',
      workspaceId,
      prompt: "Create a file named hello.txt in the current directory containing exactly 'Hello from Stewra session'. Use your file-writing tool, then briefly confirm and stop.",
    },
  });
  sessionId = start.json?.data?.session?.id;
  check('session started (status running)', start.json?.data?.session?.status === 'running' && !!sessionId);

  // 6) Wait for the session to finish (streamed via the socket).
  for (let i = 0; i < 240 && donePayload === null; i += 1) await sleep(500);

  check('streamed at least one update', updates.length > 0);
  check('permission requested + answered', permissionSeen);
  check('session-done received', donePayload !== null);
  check('session completed', donePayload?.status === 'completed');

  // 7) Verify the real edit landed in the session's isolated worktree.
  const worktree = join(tmpdir(), 'stewra-runner', 'worktrees', sessionId ?? '');
  const target = join(worktree, 'hello.txt');
  const exists = await stat(target).then(() => true).catch(() => false);
  const content = exists ? await readFile(target, 'utf8') : '';
  check('hello.txt created in worktree', exists);
  check('hello.txt has expected content', content.includes('Hello from Stewra session'));

  // 8) The main checkout must be untouched (isolation).
  const leaked = await stat(join(repo, 'hello.txt')).then(() => true).catch(() => false);
  check('main checkout untouched (isolation)', !leaked);

  console.log(`\n== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ==\n`);

  web.disconnect();
  client.disconnect();
  await api('DELETE', `/runner/devices/${deviceId}`, { token: jwt }).catch(() => undefined);
  await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\nDRIVER ERROR:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
