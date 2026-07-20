// Live smoke for Phase 3 git follow-through at the RUNNER level (no backend, no prod DB). Drives the REAL
// SessionManager + AcpSession (claude-code) against a throwaway repo with a real (local bare) remote:
//   start a session -> agent writes a file -> auto-commit on completion -> push() to the remote.
// Asserts the branch really landed on the remote. Run: cd runner && npx tsx smoke-followthrough.mts
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  RunnerPermissionPromptPayload,
  RunnerSessionDonePayload,
  RunnerSessionUpdatePayload,
  RunnerWorkspace,
} from '@stewra/shared-types';
import { SessionManager } from './src/core/sessionManager.js';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd });

process.env['STEWRA_RUNNER_ACP_CLAUDE_CODE'] = 'npx -y @agentclientprotocol/claude-agent-acp';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  ok ? (pass += 1) : (fail += 1);
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms)),
  ]);
}

async function main(): Promise<void> {
  // A real repo with a real remote — a bare repo on disk. Push is real git over a real refspec.
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

  const workspace: RunnerWorkspace = { id: 'ws_ft', name: 'ft', path: repo, defaultBranch: 'main' };

  let done: RunnerSessionDonePayload | null = null;
  let resolveDone: () => void = () => undefined;
  const doneReceived = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const manager = new SessionManager(
    {
      update: (u: RunnerSessionUpdatePayload) => {
        if (u.kind === 'status' || u.kind === 'diff') console.log(`    [${u.kind}] ${(u.text ?? '').split('\n')[0]}`);
      },
      done: (d: RunnerSessionDonePayload) => {
        done = d;
        resolveDone();
      },
      permission: (p: RunnerPermissionPromptPayload) => {
        const pick = p.options.find((o) => o.kind === 'allow_always')
          ?? p.options.find((o) => o.kind === 'allow_once') ?? p.options[0];
        console.log(`    [permission] "${p.title}" -> allow "${pick?.label}"`);
        if (pick !== undefined) manager.decide({ sessionId: p.sessionId, promptId: p.promptId, optionId: pick.id });
      },
    },
    (id) => (id === workspace.id ? workspace : undefined),
  );

  const sessionId = 'ft-session-1';
  try {
    console.log('starting session (first run npx-downloads the adapter)…');
    const ack = await withTimeout(
      manager.start({
        sessionId,
        harness: 'claude-code',
        workspaceId: workspace.id,
        prompt: "Create a file named hello.txt containing exactly 'Hello from Stewra runner'. Use your file tool, then stop.",
      }),
      180_000,
      'manager.start',
    );
    check('session accepted', ack.accepted);

    await withTimeout(doneReceived, 240_000, 'session-done');
    const d: RunnerSessionDonePayload | null = done;
    check('session completed', d?.status === 'completed');
    check('reported a branch', typeof d?.branch === 'string' && d.branch.length > 0);
    check('auto-committed the work', d?.committed === true);
    check('reported a head sha', typeof d?.headSha === 'string' && (d.headSha ?? '').length === 40);

    console.log('pushing the session branch to the remote…');
    const pushAck = await withTimeout(manager.push({ sessionId }), 60_000, 'manager.push');
    check('push ok', pushAck.ok === true);
    check('push returned the remote url', pushAck.remoteUrl === bare);

    const { stdout: ls } = await execFileAsync('git', ['ls-remote', '--heads', bare, d?.branch ?? ''], { cwd: repo });
    check('branch really exists on the remote', ls.includes(`refs/heads/${d?.branch ?? ''}`));

    // The main checkout must be untouched — isolation still holds through follow-through.
    const { stdout: mainStatus } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
    check('main checkout untouched', mainStatus.trim() === '');
  } finally {
    await manager.disposeAll().catch(() => undefined);
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(bare, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\n== ${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`} (${pass}/${pass + fail}) ==`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error('\nSMOKE ERROR:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
