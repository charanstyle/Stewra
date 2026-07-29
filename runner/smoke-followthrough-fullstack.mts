// Full-stack Phase 3 git follow-through live driver. Extends the Phase 2 driver: after a REAL session
// completes and auto-commits, it drives the REAL web REST surface -> backend -> socket -> runner to
//   POST /runner/sessions/:id/push   (pushes the session branch to a real (local bare) remote)
//   POST /runner/sessions/:id/pr     (asserts the fail-LOUD path when `gh` is absent — no silent skip)
// and asserts the branch/headSha/pushed fields round-trip through the prod DB (GET /runner/sessions).
// Run AFTER the backend is up, with migration 035 applied.
//   cd runner && BASE=http://127.0.0.1:3001 npx tsx smoke-followthrough-fullstack.mts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { io as ioc } from 'socket.io-client';
import { loadRunnerConfig } from './src/config.js';
import { StewraRunnerClient } from './src/core/stewraRunnerClient.js';
import { detectHarnesses, detectWorkspaces } from './src/core/capabilities.js';
import type {
  RunnerDevice,
  RunnerHelloPayload,
  RunnerPermissionPromptPayload,
  RunnerSession,
  RunnerSessionDonePayload,
} from '@stewra/shared-types';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd });
// Required: this names the backend the whole drive talks to. The old default pointed at :3999, which
// nothing in this repo serves — so an unset BASE produced a connection refused against a port that was
// never right, describing the wrong system instead of the missing setting.
const BASE = process.env['BASE'];
if (!BASE) throw new Error('BASE is required — the backend base URL, e.g. BASE=http://127.0.0.1:3001');
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
const EMAIL = env['E2E_USER_A_EMAIL'];
const PASSWORD = env['E2E_USER_A_PASSWORD'];

let failures = 0;
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

/**
 * The REST envelope this driver asserts against. `data` is named per call site rather than left `any`: the
 * driver exists to catch shape drift between the backend and the web surface, and a blanket `any` silenced
 * exactly the mismatches it is here to find.
 */
interface ApiEnvelope<T> {
  readonly data?: T;
  readonly error?: { readonly message?: string };
}

async function api<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: ApiEnvelope<T> | null }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  // A non-JSON body is a real outcome here (a 502 from a proxy, an empty 204), and `null` is distinguishable
  // from a parsed result — every caller below asserts on `status` too.
  const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  return { status: res.status, json };
}

async function main(): Promise<void> {
  console.log(`\n== Runner Phase 3 follow-through full-stack driver (${BASE}) ==\n`);

  // A throwaway repo the runner exposes as a workspace, wired to a REAL (local bare) remote so the
  // server-driven push travels a real refspec over a real transport.
  const repo = await mkdtemp(join(tmpdir(), 'stewra-ft-repo-'));
  const bare = await mkdtemp(join(tmpdir(), 'stewra-ft-remote-'));
  await git(bare, ['init', '-q', '--bare']);
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'ft@stewra.local']);
  await git(repo, ['config', 'user.name', 'Stewra FT']);
  await git(repo, ['remote', 'add', 'origin', bare]);
  await writeFile(join(repo, 'README.md'), '# ft repo\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  console.log(`repo: ${repo}\nremote: ${bare}`);

  process.env['STEWRA_API_URL'] = BASE;
  process.env['STEWRA_API_PREFIX'] = '';
  process.env['STEWRA_RUNNER_WORKSPACES'] = repo;
  process.env['STEWRA_RUNNER_ACP_CLAUDE_CODE'] = 'npx -y @agentclientprotocol/claude-agent-acp';

  const login = await api<{ tokens?: { accessToken?: string } }>('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  const jwt = login.json?.data?.tokens?.accessToken;
  check('login', login.status === 200 && !!jwt);
  // Stop here rather than carrying `undefined` into every later call: without a token the whole drive sends
  // `Authorization: Bearer undefined` and fails at some arbitrary later step, describing the wrong problem.
  if (jwt === undefined) throw new Error('login returned no access token — check .env.e2e credentials');
  const pair = await api<{ code?: string }>('POST', '/runner/pair', { token: jwt });
  const code = pair.json?.data?.code;
  check('pairing code minted', !!code);
  if (code === undefined) throw new Error('POST /runner/pair returned no pairing code');

  const config = loadRunnerConfig(process.env, '0.1.0');
  const client = new StewraRunnerClient(config);
  const token = await client.claimToken(code, 'phase3-ft-driver', process.platform);
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

  let deviceId: string | undefined;
  let workspaceId: string | undefined;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    const devices =
      (await api<{ devices?: RunnerDevice[] }>('GET', '/runner/devices', { token: jwt })).json?.data?.devices ?? [];
    const d = devices.find((x) => x.online && x.name === 'phase3-ft-driver');
    if (d && d.workspaces.length > 0 && d.harnesses.some((h) => h.id === 'claude-code' && h.available)) {
      deviceId = d.id;
      workspaceId = d.workspaces[0]?.id;
      break;
    }
  }
  check('runner online (connected)', connected);
  check('device + workspace + claude-code reported', !!deviceId && !!workspaceId);
  if (!deviceId || !workspaceId) throw new Error('runner never came online with a usable workspace');

  const web = ioc(BASE, { path: '/socket.io', auth: { token: jwt }, transports: ['websocket'], reconnection: false });
  await new Promise<void>((res, rej) => {
    web.once('connect', () => res());
    web.once('connect_error', rej);
    setTimeout(() => rej(new Error('web socket connect timeout')), 8000);
  });

  // The done payload rides a promise rather than a `let` the handler fills in. TypeScript does not track
  // assignments made inside a callback, so a `let donePayload: RunnerSessionDonePayload | null = null` stays
  // narrowed to `null` at every read below — the old `any` annotation was the only reason that never showed
  // up as an error, and it took the checking of the assertions with it.
  let resolveDone: (d: RunnerSessionDonePayload) => void = () => undefined;
  const doneReceived = new Promise<RunnerSessionDonePayload>((resolve) => {
    resolveDone = resolve;
  });
  web.on('runner-ui:session-done', (e: RunnerSessionDonePayload) => {
    resolveDone(e);
  });

  // A holder, not a `let`: the permission handler has to be live BEFORE the session exists (an early prompt
  // would otherwise be missed), so it must close over something the POST below can still fill in.
  const started: { sessionId?: string | undefined } = {};
  web.on('runner-ui:permission-request', (e: RunnerPermissionPromptPayload) => {
    const opt =
      e.options.find((o) => o.kind === 'allow_always') ?? e.options.find((o) => o.kind === 'allow_once') ?? e.options[0];
    console.log(`     [permission] "${e.title}" -> allow "${opt?.label}"`);
    if (started.sessionId !== undefined && opt !== undefined) {
      void api<never>('POST', `/runner/sessions/${started.sessionId}/permission`, {
        token: jwt,
        body: { promptId: e.promptId, optionId: opt.id },
      });
    }
  });

  const start = await api<{ session?: RunnerSession }>('POST', '/runner/sessions', {
    token: jwt,
    body: {
      deviceId,
      harness: 'claude-code',
      workspaceId,
      prompt: "Create a file named hello.txt in the current directory containing exactly 'Hello from Stewra follow-through'. Use your file-writing tool, then briefly confirm and stop.",
    },
  });
  started.sessionId = start.json?.data?.session?.id;
  check('session started (status running)', start.json?.data?.session?.status === 'running' && !!started.sessionId);

  // Same 120s ceiling the old poll loop had.
  const donePayload = await Promise.race([doneReceived, sleep(120_000).then(() => null)]);
  check('session-done received', donePayload !== null);
  check('session completed', donePayload?.status === 'completed');
  check('done payload carries a branch', typeof donePayload?.branch === 'string' && donePayload.branch.length > 0);
  check('done payload committed=true', donePayload?.committed === true);
  const branch: string = donePayload?.branch ?? '';

  // The DB must already hold branch/headSha from handleDone (persisted before any push).
  const afterDone =
    (await api<{ sessions?: RunnerSession[] }>('GET', '/runner/sessions', { token: jwt })).json?.data?.sessions ?? [];
  const s1 = afterDone.find((x) => x.id === started.sessionId);
  check('DB persisted branch on done', s1?.branch === branch && !!branch);
  check('DB persisted a 40-char headSha on done', typeof s1?.headSha === 'string' && s1.headSha.length === 40);
  check('DB shows pushed=false before push', s1?.pushed === false);

  // --- Push via the REST surface: web -> backend -> emitWithAck -> runner -> real git push ---
  console.log('\n  pushing the session branch via POST /runner/sessions/:id/push …');
  const push = await api<{ remoteUrl?: string; session?: RunnerSession }>(
    'POST',
    `/runner/sessions/${started.sessionId}/push`,
    { token: jwt, body: {} },
  );
  check('push endpoint 200', push.status === 200);
  check('push returned the remote url', push.json?.data?.remoteUrl === bare);
  check('push response session pushed=true', push.json?.data?.session?.pushed === true);

  const { stdout: ls } = await execFileAsync('git', ['ls-remote', '--heads', bare, branch]);
  check('branch really landed on the remote', ls.includes(`refs/heads/${branch}`));

  // DB round-trip: pushed=true must persist.
  const afterPush =
    (await api<{ sessions?: RunnerSession[] }>('GET', '/runner/sessions', { token: jwt })).json?.data?.sessions ?? [];
  const s2 = afterPush.find((x) => x.id === started.sessionId);
  check('DB persisted pushed=true', s2?.pushed === true);

  // --- Open-PR via REST: gh is ABSENT here, so the wiring must FAIL LOUD (no silent skip) ---
  console.log('\n  opening a PR via POST /runner/sessions/:id/pr (expect fail-loud, gh absent) …');
  const pr = await api<{ prUrl?: string; session?: RunnerSession }>('POST', `/runner/sessions/${started.sessionId}/pr`, {
    token: jwt,
    body: { title: 'Stewra runner follow-through', body: 'Automated PR from the Phase 3 smoke.' },
  });
  const prMsg = pr.json?.error?.message ?? '';
  check('PR endpoint rejects (4xx), does not 200', pr.status >= 400 && pr.status < 500);
  check('PR failure is loud + specific (mentions gh)', /gh_missing|gh\b|GitHub CLI/i.test(prMsg));
  console.log(`     [pr error] ${prMsg}`);

  console.log(`\n== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ==\n`);

  web.disconnect();
  client.disconnect();
  await api<never>('DELETE', `/runner/devices/${deviceId}`, { token: jwt }).catch(() => undefined);
  await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  await rm(bare, { recursive: true, force: true }).catch(() => undefined);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\nDRIVER ERROR:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
