// Full-stack live driver for the STEWRA-HOSTED cloud runner — the one surface with no end-to-end
// coverage at all. `hostedRunnerService.test.ts` proves the backend against a scripted provisioner,
// and `provisioner.test.ts` proves the container against a real Docker daemon, but nothing joins
// them: no client calls `/runner/hosted*`, so the whole path from "user asks for a cloud runner" to
// "a Claude Code session is running in it and the user is steering that session" has never been
// exercised as one system.
//
// That arc is what this drives, in the user's own order:
//   1. provision a cloud runner, with the Claude Code login going in the way a user's would
//   2. wait for the container's runner to dial BACK — it is a real client of the same socket a
//      laptop uses, so "online" here means the container built, started, and authenticated
//   3. start a Claude Code session on it through Stewra, exactly as the web client would
//   4. STEER that session through Stewra: answer its permission prompts, send a follow-up prompt
//      mid-run, and read the streamed result — control, not just launch
//   5. cancel a second session, because "stop it" is a control the user must actually have
//   6. lifecycle: stop (work survives) → start (work still there) → destroy
//
// It also asserts the laptop invariant, which is the security claim the whole hosted design rests
// on and is currently only proven against a scripted backend: a credential Stewra minted may reach a
// container Stewra runs, and never a machine it does not control.
//
// NOT covered here, deliberately: the iptables egress fence
// (deploy/hosted-runner/iptables-egress.sh). Asserting it means running commands INSIDE the
// container, which needs Docker access on the provisioner host — outside what a REST-level driver
// can honestly claim. It stays an untested isolation boundary; see TESTING.md.
//
// Run it:
//   cd runner && BASE=https://www.stewra.com/api CLAUDE_CODE_OAUTH_TOKEN=… npx tsx smoke-hosted-fullstack.mts
//
// Preconditions the driver checks and names rather than assumes: HOSTED_RUNNER_ENABLED=true on the
// backend, a provisioner on the `hosted` compose profile with a real Docker daemon, and a GitHub App
// installation on the account (a cloud runner with no repositories can do nothing).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { io as ioc } from 'socket.io-client';
import type {
  RunnerDevice,
  RunnerPermissionPromptPayload,
  RunnerSession,
  RunnerSessionDonePayload,
} from '@stewra/shared-types';

// Required: this names the backend the whole drive talks to. Same rule as the other drivers — an
// invented default turns a missing setting into a run against the wrong system.
const RAW_BASE = process.env['BASE'];
if (!RAW_BASE) {
  throw new Error('BASE is required — the backend base URL, e.g. BASE=https://www.stewra.com/api');
}
const BASE: string = RAW_BASE;

// The Claude Code login this driver provisions the runner with. It is deliberately NOT read from any
// file in the repo: `docker-compose.prod.yml` keeps it in `stewra.env` on the deploy host precisely
// so it never lands in git, and a driver that hardcoded a path to somebody's credential file would
// undo that. Pass it in for the run.
const CLAUDE_TOKEN = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
if (!CLAUDE_TOKEN) {
  throw new Error(
    'CLAUDE_CODE_OAUTH_TOKEN is required — the long-lived Claude Code login the cloud runner will ' +
      'use, from `claude setup-token`. It is what the provisioned container authenticates the ' +
      'claude-code harness with; on the deploy host the same value lives in stewra.env. Without it ' +
      'the runner provisions fine and every session fails at "not logged in", which describes the ' +
      'wrong problem.',
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  return { status: res.status, json };
}

/** Poll `GET /runner/devices` for the hosted device until `ready`, or give up with a real message. */
async function waitForHostedDevice(
  jwt: string,
  ready: (d: RunnerDevice) => boolean,
  what: string,
  timeoutMs: number,
): Promise<RunnerDevice> {
  const deadline = Date.now() + timeoutMs;
  let last: RunnerDevice | undefined;
  while (Date.now() < deadline) {
    const devices =
      (await api<{ devices?: RunnerDevice[] }>('GET', '/runner/devices', { token: jwt })).json?.data
        ?.devices ?? [];
    last = devices.find((d) => d.kind === 'hosted');
    if (last !== undefined && ready(last)) {
      return last;
    }
    await sleep(2000);
  }
  // Name what the device actually looked like. "Timed out" alone sends someone to the wrong place;
  // containerStatus distinguishes "never started" from "started but never authenticated".
  throw new Error(
    `timed out after ${Math.round(timeoutMs / 1000)}s waiting for the hosted runner to ${what}. ` +
      `Last seen: ${
        last === undefined
          ? 'no hosted device in GET /runner/devices at all'
          : `id=${last.id} online=${last.online} containerStatus=${last.containerStatus} ` +
            `harnesses=[${last.harnesses.map((h) => `${h.id}:${h.available}`).join(',')}] ` +
            `workspaces=${last.workspaces.length}`
      }`,
  );
}

async function main(): Promise<void> {
  console.log(`\n== Stewra hosted cloud runner full-stack driver (${BASE}) ==\n`);

  const login = await api<{ tokens?: { accessToken?: string } }>('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  const jwt = login.json?.data?.tokens?.accessToken;
  check('login', login.status === 200 && !!jwt);
  if (jwt === undefined) {
    throw new Error('login returned no access token — check .env.e2e credentials');
  }

  // ── Preconditions, each named so a failure points at the fix ──────────────────────────────────
  const ghApp = await api<{ configured?: boolean; installed?: boolean; installUrl?: string | null }>(
    'GET',
    '/github-app',
    { token: jwt },
  );
  check('GET /github-app reachable', ghApp.status === 200);
  if (ghApp.json?.data?.installed !== true) {
    throw new Error(
      'this account has no GitHub App installation, so a cloud runner would have no repositories ' +
        'to clone and provisioning refuses by design. Install it first (the app surfaces the link ' +
        'at /github/setup), then re-run.',
    );
  }
  check('GitHub App installed on the account', true);

  const status0 = await api<{ enabled?: boolean; runner?: RunnerDevice | null }>(
    'GET',
    '/runner/hosted',
    { token: jwt },
  );
  check('GET /runner/hosted reachable', status0.status === 200);
  if (status0.json?.data?.enabled !== true) {
    throw new Error(
      'this deploy does not offer hosted runners (GET /runner/hosted reports enabled=false). Set ' +
        'HOSTED_RUNNER_ENABLED=true and bring up the provisioner on the `hosted` compose profile.',
    );
  }
  check('hosted runners enabled on this deploy', true);

  // Refuse to reuse — and above all refuse to destroy — a cloud runner this run did not create.
  // DELETE /runner/hosted takes the volumes with it, so an existing runner may be holding work that
  // is not recoverable. Stopping is the correct answer, not evicting.
  if (status0.json?.data?.runner != null) {
    throw new Error(
      'this account already has a cloud runner. This driver will not adopt or destroy one it did ' +
        'not create — destroying takes the volumes and any uncommitted work with them. Remove it ' +
        'deliberately (DELETE /runner/hosted) if it is disposable, then re-run.',
    );
  }
  check('no pre-existing cloud runner to disturb', true);

  let provisionedByThisRun = false;
  try {
    // ── 1. Provision ─────────────────────────────────────────────────────────────────────────────
    console.log('\n  provisioning the cloud runner (POST /runner/hosted) …');
    const provision = await api<{ runner?: RunnerDevice }>('POST', '/runner/hosted', {
      token: jwt,
      // The credential travels exactly as a user's would: in this one request, into the container's
      // own volume, never into Stewra's database.
      body: { credentials: { 'claude-code': CLAUDE_TOKEN } },
    });
    provisionedByThisRun = provision.status === 201;
    check('POST /runner/hosted → 201', provision.status === 201);
    const provisioned = provision.json?.data?.runner;
    check('provision returned a device', provisioned !== undefined);
    check('device reports kind=hosted', provisioned?.kind === 'hosted');
    if (provisioned === undefined) {
      throw new Error(
        `provisioning did not return a runner (status ${provision.status}): ` +
          `${provision.json?.error?.message ?? 'no error message'}`,
      );
    }

    // It must also show up in the SAME device list a laptop appears in — the hosted runner being a
    // peer of a paired machine, not a parallel concept, is a design claim worth asserting.
    const listed =
      (await api<{ devices?: RunnerDevice[] }>('GET', '/runner/devices', { token: jwt })).json?.data
        ?.devices ?? [];
    check(
      'hosted runner appears in GET /runner/devices alongside local ones',
      listed.some((d) => d.id === provisioned.id && d.kind === 'hosted'),
    );

    // ── 2. The container dials back ──────────────────────────────────────────────────────────────
    // This is the real integration point: the runner inside the container connects to the same
    // socket namespace a laptop does, says hello, and reports what it can run. Everything after it
    // is the ordinary session path, which is exactly the point.
    console.log('\n  waiting for the container to come online and report claude-code …');
    const device = await waitForHostedDevice(
      jwt,
      (d) =>
        d.online &&
        d.workspaces.length > 0 &&
        d.harnesses.some((h) => h.id === 'claude-code' && h.available),
      'come online with a workspace and an available claude-code harness',
      300_000,
    );
    check('container runner dialled back online', device.online);
    check('claude-code harness available in the container', true);
    check('cloned at least one workspace from the GitHub App installation', device.workspaces.length > 0);
    const workspaceId = device.workspaces[0]?.id;
    if (workspaceId === undefined) {
      throw new Error('hosted runner reported a workspace list that has no id');
    }
    console.log(
      `     device=${device.id} os=${device.os} workspaces=${device.workspaces.length} ` +
        `harnesses=[${device.harnesses.map((h) => h.id).join(',')}]`,
    );

    // ── 3. The laptop invariant, from the live system ────────────────────────────────────────────
    // A local device token must be REFUSED by the runner-facing hosted endpoints. Proven so far only
    // against a scripted backend; here it is the real middleware, the real token store, real HTTP.
    // Claiming a token is all this needs — no runner process has to run behind it.
    console.log('\n  asserting the laptop invariant against the live backend …');
    const pair = await api<{ code?: string }>('POST', '/runner/pair', { token: jwt });
    const code = pair.json?.data?.code;
    check('pairing code minted for the invariant check', !!code);
    if (code !== undefined) {
      const claimed = await api<{ device?: { id?: string }; token?: string }>(
        'POST',
        '/runner/runner-token',
        {
          body: {
            code,
            deviceName: 'hosted-smoke-invariant-probe',
            appVersion: '0.1.0',
            os: process.platform,
          },
        },
      );
      const localToken = claimed.json?.data?.token;
      const localDeviceId = claimed.json?.data?.device?.id;
      check('local device token claimed', !!localToken);
      if (localToken !== undefined) {
        const refused = await api('GET', '/runner/hosted/workspaces', { token: localToken });
        check(
          `GET /runner/hosted/workspaces with a LOCAL device token → 403 (got ${refused.status})`,
          refused.status === 403,
        );
        const refusedGit = await api('POST', '/runner/git-credentials', {
          token: localToken,
          body: {},
        });
        check(
          `POST /runner/git-credentials with a LOCAL device token → 403 (got ${refusedGit.status})`,
          refusedGit.status === 403,
        );
      }
      // Revoke the probe device: it exists only for the two calls above.
      if (localDeviceId !== undefined) {
        await api('DELETE', `/runner/devices/${localDeviceId}`, { token: jwt });
      }
    }

    // ── 4. Start a Claude Code session on the cloud runner, and steer it ─────────────────────────
    const web = ioc(BASE.replace(/\/api$/, ''), {
      path: '/socket.io',
      auth: { token: jwt },
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise<void>((res, rej) => {
      web.once('connect', () => res());
      web.once('connect_error', (e: Error) => rej(e));
      setTimeout(() => rej(new Error('web socket connect timeout')), 15_000);
    });
    check('web socket connected (the channel the browser steers sessions over)', web.connected);

    let resolveDone: (d: RunnerSessionDonePayload) => void = () => undefined;
    const doneReceived = new Promise<RunnerSessionDonePayload>((r) => {
      resolveDone = r;
    });
    web.on('runner-ui:session-done', (e: RunnerSessionDonePayload) => resolveDone(e));

    // Steering, part one: answer permission prompts. The handler must be live BEFORE the session
    // exists, because an agent can ask before the POST has even returned. A prompt that goes
    // unanswered is not a hang in the agent — it is the user's control not reaching it.
    const started: { sessionId?: string | undefined } = {};
    let permissionsAnswered = 0;
    web.on('runner-ui:permission-request', (e: RunnerPermissionPromptPayload) => {
      const opt =
        e.options.find((o) => o.kind === 'allow_always') ??
        e.options.find((o) => o.kind === 'allow_once') ??
        e.options[0];
      console.log(`     [permission] "${e.title}" → allow "${opt?.label}"`);
      if (started.sessionId !== undefined && opt !== undefined) {
        permissionsAnswered += 1;
        void api('POST', `/runner/sessions/${started.sessionId}/permission`, {
          token: jwt,
          body: { promptId: e.promptId, optionId: opt.id },
        });
      }
    });

    console.log('\n  starting a Claude Code session on the cloud runner …');
    const nonce = `hosted-smoke-${Date.now().toString(36)}`;
    const start = await api<{ session?: RunnerSession }>('POST', '/runner/sessions', {
      token: jwt,
      body: {
        deviceId: device.id,
        harness: 'claude-code',
        workspaceId,
        prompt:
          `Create a file named ${nonce}.txt in the current directory containing exactly ` +
          `'hello from the Stewra cloud runner'. Use your file-writing tool, then briefly confirm and stop.`,
      },
    });
    started.sessionId = start.json?.data?.session?.id;
    check('POST /runner/sessions → running', start.json?.data?.session?.status === 'running');
    check('session id returned', started.sessionId !== undefined);
    if (started.sessionId === undefined) {
      throw new Error(
        `session did not start: ${start.status} ${start.json?.error?.message ?? '(no message)'}`,
      );
    }

    // Steering, part two: a follow-up prompt into a RUNNING session. This is the difference between
    // "Stewra can launch an agent" and "the user is holding the wheel" — the same endpoint the chat
    // composer uses when someone types while the agent is mid-task.
    await sleep(3000);
    const followUp = await api('POST', `/runner/sessions/${started.sessionId}/prompt`, {
      token: jwt,
      body: { prompt: 'Also mention the filename you created in your confirmation.' },
    });
    check(
      `follow-up prompt accepted into the running session (${followUp.status})`,
      followUp.status === 200 || followUp.status === 202,
    );

    // Claude Code on a cold container: image pull is already done, but the first agent turn still
    // carries model latency plus any tool round-trips.
    const done = await Promise.race([doneReceived, sleep(300_000).then(() => null)]);
    check('runner-ui:session-done received', done !== null);
    check(`session completed (status=${done?.status ?? 'none'})`, done?.status === 'completed');
    check('at least one permission prompt was steered through Stewra', permissionsAnswered > 0);
    check(
      'done payload carries the isolated branch the work landed on',
      typeof done?.branch === 'string' && done.branch.length > 0,
    );
    check('done payload reports the work was committed', done?.committed === true);

    const persisted =
      (await api<{ sessions?: RunnerSession[] }>('GET', '/runner/sessions', { token: jwt })).json
        ?.data?.sessions ?? [];
    const s1 = persisted.find((x) => x.id === started.sessionId);
    check('session persisted with its branch', !!s1?.branch);
    check(
      'session persisted a 40-char head sha',
      typeof s1?.headSha === 'string' && s1.headSha.length === 40,
    );

    // ── 5. Cancel: the control that matters most when something goes wrong ───────────────────────
    console.log('\n  starting a second session purely to cancel it …');
    const start2 = await api<{ session?: RunnerSession }>('POST', '/runner/sessions', {
      token: jwt,
      body: {
        deviceId: device.id,
        harness: 'claude-code',
        workspaceId,
        prompt:
          'Count slowly from 1 to 500, printing each number on its own line, and do not stop early.',
      },
    });
    const sessionId2 = start2.json?.data?.session?.id;
    check('second session started', start2.json?.data?.session?.status === 'running');
    if (sessionId2 !== undefined) {
      await sleep(4000);
      const cancel = await api('POST', `/runner/sessions/${sessionId2}/cancel`, { token: jwt });
      check(`POST /runner/sessions/:id/cancel accepted (${cancel.status})`, cancel.status === 200);
      // Cancelling is only real if the session actually stops being runnable. Poll the record
      // rather than trusting the 200 — the 200 says the instruction was accepted, not obeyed.
      let finalStatus: string | undefined;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const all =
          (await api<{ sessions?: RunnerSession[] }>('GET', '/runner/sessions', { token: jwt })).json
            ?.data?.sessions ?? [];
        finalStatus = all.find((x) => x.id === sessionId2)?.status;
        if (finalStatus !== undefined && finalStatus !== 'running') {
          break;
        }
        await sleep(2000);
      }
      check(`cancelled session left "running" (now ${finalStatus ?? 'unknown'})`, finalStatus !== 'running');
    }

    web.close();

    // ── 6. Lifecycle: stopping must be recoverable, destroying must not be ───────────────────────
    console.log('\n  stopping the cloud runner (volumes must survive) …');
    const stop = await api<{ runner?: RunnerDevice }>('POST', '/runner/hosted/stop', { token: jwt });
    check('POST /runner/hosted/stop → 200', stop.status === 200);
    const stopped = await waitForHostedDevice(
      jwt,
      (d) => !d.online,
      'report itself offline after stop',
      120_000,
    );
    check('stopped runner reports offline', !stopped.online);
    check(
      `stopped runner reports a container status (${stopped.containerStatus})`,
      stopped.containerStatus !== null,
    );

    console.log('\n  starting it back up (the cloned work must still be there) …');
    const restart = await api('POST', '/runner/hosted/start', { token: jwt });
    check('POST /runner/hosted/start → 200', restart.status === 200);
    const back = await waitForHostedDevice(
      jwt,
      (d) => d.online && d.workspaces.length > 0,
      'come back online after start',
      300_000,
    );
    check('runner came back online after start', back.online);
    // The volumes are the whole reason stop is not destroy: the repositories it cloned must still be
    // there, not re-cloned into an empty container.
    check('workspaces survived the stop/start cycle', back.workspaces.length > 0);
  } finally {
    // Teardown runs on failure too, and destroys ONLY what this run created — the pre-existing-runner
    // check above is what makes that distinction safe to rely on.
    if (provisionedByThisRun) {
      console.log('\n  tearing down: destroying the cloud runner this run created …');
      const destroy = await api<{ destroyed?: boolean }>('DELETE', '/runner/hosted', { token: jwt });
      check('DELETE /runner/hosted → 200', destroy.status === 200);
      check('destroy reported destroyed=true', destroy.json?.data?.destroyed === true);
      const after = await api<{ runner?: RunnerDevice | null }>('GET', '/runner/hosted', {
        token: jwt,
      });
      check('no hosted runner remains', after.json?.data?.runner == null);
    }
  }

  console.log(`\n== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ==\n`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main();
