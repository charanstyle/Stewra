import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  RunnerPermissionPromptPayload,
  RunnerSessionDonePayload,
  RunnerSessionUpdatePayload,
  RunnerStartSessionPayload,
  RunnerWorkspace,
} from '@stewra/shared-types';
import { acpEnvKey } from '../core/harnessCommand.js';
import { SessionManager } from '../core/sessionManager.js';

const execFileAsync = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const ENV_KEY = acpEnvKey('claude-code');

/**
 * Everything here is real: a real git repository (with a real bare `origin` to push to), the real
 * AcpSession, and a real agent subprocess — the scripted fixture, launched through the same env
 * override a user would use for an off-PATH adapter. The only injected piece is the SessionEmitter,
 * which is the manager's own output port; recording what it emits IS the assertion surface.
 *
 * Not covered here, deliberately: the `gh pr create` success path — its collaborator is github.com,
 * which a unit test cannot reach honestly. runner/smoke-followthrough.mts is the documented
 * live-integration layer for it; this file covers openPr's refusal paths.
 */
async function git(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return execFileAsync('git', args, { cwd });
}

interface Emitted {
  updates: RunnerSessionUpdatePayload[];
  done: RunnerSessionDonePayload[];
  permissions: RunnerPermissionPromptPayload[];
}

function recordingEmitter(): { emitter: ConstructorParameters<typeof SessionManager>[0]; seen: Emitted } {
  const seen: Emitted = { updates: [], done: [], permissions: [] };
  return {
    emitter: {
      update: (payload) => seen.updates.push(payload),
      done: (payload) => seen.done.push(payload),
      permission: (payload) => seen.permissions.push(payload),
    },
    seen,
  };
}

/** Await a real condition (a subprocess finishing, an event landing) with a real clock. */
async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('SessionManager (real git, real AcpSession, scripted agent subprocess)', () => {
  let repo: string;
  let remote: string;
  let workspace: RunnerWorkspace;
  const savedEnv = process.env[ENV_KEY];
  const managers: SessionManager[] = [];

  const useAgent = (scenario: string): void => {
    process.env[ENV_KEY] = `${process.execPath} ${FIXTURE} ${scenario}`;
  };

  const manage = (
    resolve: (id: string) => RunnerWorkspace | undefined,
    seenEmitter: ConstructorParameters<typeof SessionManager>[0],
    options?: { readonly maxCompleted?: number },
  ): SessionManager => {
    const manager = new SessionManager(seenEmitter, resolve, options);
    managers.push(manager);
    return manager;
  };

  const startPayload = (
    sessionId: string,
    overrides: Partial<RunnerStartSessionPayload> = {},
  ): RunnerStartSessionPayload => ({
    sessionId,
    harness: 'claude-code',
    workspaceId: 'ws-1',
    prompt: 'fix the bug in the widget',
    ...overrides,
  });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'stewra-sm-repo-'));
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@stewra.local']);
    await git(repo, ['config', 'user.name', 'Stewra Test']);
    await execFileAsync('touch', [join(repo, 'README.md')]);
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'initial']);
    remote = await mkdtemp(join(tmpdir(), 'stewra-sm-remote-'));
    await git(remote, ['init', '-q', '--bare']);
    await git(repo, ['remote', 'add', 'origin', remote]);
    workspace = { id: 'ws-1', name: 'repo', path: repo, defaultBranch: 'main' };
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.disposeAll()));
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(remote, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('start refusals', () => {
    it('refuses a duplicate sessionId', async () => {
      useAgent('happy');
      const { emitter, seen } = recordingEmitter();
      const manager = manage(() => workspace, emitter);
      expect(await manager.start(startPayload('s-dup'))).toEqual({ accepted: true });
      expect(await manager.start(startPayload('s-dup'))).toEqual({
        accepted: false,
        error: 'duplicate_session',
      });
      await until(() => seen.done.length === 1);
    });

    it('refuses an unknown workspace — the server does not get to name paths on this machine', async () => {
      useAgent('happy');
      const { emitter } = recordingEmitter();
      const manager = manage(() => undefined, emitter);
      expect(await manager.start(startPayload('s-1'))).toEqual({
        accepted: false,
        error: 'unknown_workspace',
      });
    });

    it('reports worktree_failed with the real git reason for a non-repo path', async () => {
      useAgent('happy');
      const notRepo = await mkdtemp(join(tmpdir(), 'stewra-sm-notrepo-'));
      try {
        const { emitter } = recordingEmitter();
        const manager = manage(() => ({ ...workspace, path: notRepo }), emitter);
        const ack = await manager.start(startPayload('s-1'));
        expect(ack.accepted).toBe(false);
        expect(ack.error).toMatch(/^worktree_failed: /);
      } finally {
        await rm(notRepo, { recursive: true, force: true });
      }
    });

    it('reports harness_failed and removes the fresh worktree AND its branch when the adapter cannot launch', async () => {
      process.env[ENV_KEY] = 'stewra-no-such-adapter-binary';
      const { emitter, seen } = recordingEmitter();
      const manager = manage(() => workspace, emitter);

      const ack = await manager.start(startPayload('s-1'));

      expect(ack.accepted).toBe(false);
      expect(ack.error).toMatch(/^harness_failed: .*not installed or not on PATH/);
      // Nothing ran, so nothing is worth keeping: no leftover worktree, no leftover branch.
      const { stdout } = await git(repo, ['branch', '--list', 'stewra/*']);
      expect(stdout.trim()).toBe('');
      const { stdout: worktrees } = await git(repo, ['worktree', 'list', '--porcelain']);
      expect(worktrees).not.toContain('s-1');
      expect(seen.done).toHaveLength(0);
    });
  });

  describe('a full session', () => {
    it('streams status → messages → diff → commit → done, seq strictly increasing, real sha', async () => {
      useAgent('edit');
      const { emitter, seen } = recordingEmitter();
      const manager = manage(() => workspace, emitter);

      expect(await manager.start(startPayload('s-full'))).toEqual({ accepted: true });
      await until(() => seen.done.length === 1);

      const kinds = seen.updates.map((u) => u.kind);
      expect(kinds).toEqual(['status', 'agent-message', 'agent-message', 'diff', 'status']);
      expect(seen.updates[0]?.text).toMatch(/^worktree stewra\//);
      // The diff is the real diff of the file the agent subprocess actually wrote.
      expect(seen.updates[3]?.text).toContain('agent-output.txt');
      expect(seen.updates[3]?.text).toContain('made by the scripted agent');
      expect(seen.updates[4]?.text).toMatch(/^committed [0-9a-f]{10} on stewra\//);

      const seqs = seen.updates.map((u) => u.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);

      const done = seen.done[0];
      expect(done?.status).toBe('completed');
      expect(done?.summary).toBe('stopReason: end_turn');
      expect(done?.committed).toBe(true);
      expect(done?.headSha).toMatch(/^[0-9a-f]{40}$/);
      // The commit is genuinely on the session branch in the real repo.
      const { stdout } = await git(repo, ['log', '-1', '--format=%s', done?.branch ?? '']);
      expect(stdout.trim()).toBe('Stewra runner: fix the bug in the widget');
    });

    it('bounds an oversized streamed text before it goes on the wire', async () => {
      useAgent('edit');
      const { emitter, seen } = recordingEmitter();
      const manager = manage(() => workspace, emitter);
      await manager.start(startPayload('s-big'));
      await until(() => seen.done.length === 1);

      const big = seen.updates.find((u) => (u.text?.length ?? 0) > 4_000);
      expect(big?.text?.length).toBeLessThan(8_100);
      expect(big?.text).toContain('…[truncated 1000 chars]');
    });
  });

  describe('cancel', () => {
    it('finalises exactly one done(cancelled) and reclaims worktree and branch', async () => {
      useAgent('hang');
      const { emitter, seen } = recordingEmitter();
      const manager = manage(() => workspace, emitter);

      await manager.start(startPayload('s-hang'));
      await manager.cancel({ sessionId: 's-hang' });
      // Give the (killed) turn's error path a moment — it must NOT produce a second done.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(seen.done).toEqual([{ sessionId: 's-hang', status: 'cancelled' }]);
      const { stdout } = await git(repo, ['branch', '--list', 'stewra/*']);
      expect(stdout.trim()).toBe('');
    });

    it('is a no-op for an unknown session', async () => {
      useAgent('happy');
      const { emitter, seen } = recordingEmitter();
      const manager = manage(() => workspace, emitter);
      await manager.cancel({ sessionId: 'ghost' });
      expect(seen.done).toHaveLength(0);
    });
  });

  describe('permission round-trip', () => {
    it('relays the prompt, resolves decide() through to the real harness, and the harness sees the option', async () => {
      useAgent('permission');
      const { emitter, seen } = recordingEmitter();
      const manager = manage(() => workspace, emitter);

      await manager.start(startPayload('s-perm'));
      await until(() => seen.permissions.length === 1);

      const prompt = seen.permissions[0];
      expect(prompt?.sessionId).toBe('s-perm');
      expect(prompt?.title).toBe('Run a shell command');
      expect(prompt?.options.map((o) => o.kind)).toEqual(['allow_once', 'reject_once', 'allow_always']);

      // A stale promptId must resolve nothing (and must not crash) …
      manager.decide({ sessionId: 's-perm', promptId: 'never-minted', optionId: 'yes' });
      // … while the real one flows all the way into the agent subprocess, which echoes it back.
      manager.decide({ sessionId: 's-perm', promptId: prompt?.promptId ?? '', optionId: 'yes' });
      await until(() => seen.done.length === 1);

      const echoed = seen.updates.find((u) => u.text?.startsWith('outcome:'));
      expect(echoed?.text).toBe('outcome:{"outcome":"selected","optionId":"yes"}');
      expect(seen.done[0]?.status).toBe('completed');
    });

    it('cancel() answers every pending prompt with null — the harness is told cancelled, not left hanging', async () => {
      useAgent('permission');
      const { emitter, seen } = recordingEmitter();
      const manager = manage(() => workspace, emitter);

      await manager.start(startPayload('s-permcancel'));
      await until(() => seen.permissions.length === 1);
      await manager.cancel({ sessionId: 's-permcancel' });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(seen.done).toEqual([{ sessionId: 's-permcancel', status: 'cancelled' }]);
    });
  });

  describe('follow-through and retention', () => {
    it('pushes a finished session to the real origin; unknown sessions are refused', async () => {
      useAgent('edit');
      const { emitter, seen } = recordingEmitter();
      const manager = manage(() => workspace, emitter);
      await manager.start(startPayload('s-push'));
      await until(() => seen.done.length === 1);
      const branch = seen.done[0]?.branch ?? '';

      const ack = await manager.push({ sessionId: 's-push' });
      expect(ack).toMatchObject({ ok: true, branch });
      // The branch genuinely arrived in the bare remote, at the session's head commit.
      const { stdout } = await git(remote, ['rev-parse', branch]);
      expect(stdout.trim()).toBe(seen.done[0]?.headSha);

      expect(await manager.push({ sessionId: 'ghost' })).toEqual({ ok: false, error: 'unknown_session' });
      expect(await manager.openPr({ sessionId: 'ghost', title: 'T', body: 'B' })).toEqual({
        ok: false,
        error: 'unknown_session',
      });
    });

    it('evicts the oldest completed session past the cap — directory freed, branch (the work) kept', async () => {
      useAgent('edit');
      const { emitter, seen } = recordingEmitter();
      // Injectable cap: the eviction path with real sessions, without running 101 of them.
      const manager = manage(() => workspace, emitter, { maxCompleted: 2 });

      for (const id of ['s-a', 's-b', 's-c']) {
        expect(await manager.start(startPayload(id))).toEqual({ accepted: true });
        await until(() => seen.done.some((d) => d.sessionId === id));
      }

      const first = seen.done.find((d) => d.sessionId === 's-a');
      const firstBranch = first?.branch ?? '';
      // Evicted: no longer pushable, and its checkout directory goes away. The reclaim is
      // fire-and-forget in production (sessionManager only frees disk, never blocks a session on
      // it), so the disappearance is polled for, not asserted instantly.
      expect(await manager.push({ sessionId: 's-a' })).toEqual({ ok: false, error: 'unknown_session' });
      await until(
        async () => !(await git(repo, ['worktree', 'list', '--porcelain'])).stdout.includes('s-a'),
      );
      // … but the branch and its commit survive in the repo: eviction never deletes work.
      const { stdout } = await git(repo, ['rev-parse', firstBranch]);
      expect(stdout.trim()).toBe(first?.headSha);
      // The two newest are still retained and pushable.
      expect(await manager.push({ sessionId: 's-b' })).toMatchObject({ ok: true });
      expect(await manager.push({ sessionId: 's-c' })).toMatchObject({ ok: true });
    });
  });

  describe('disposeAll', () => {
    it('cancels live sessions and reclaims retained checkouts; branches survive', async () => {
      useAgent('edit');
      const { emitter, seen } = recordingEmitter();
      const manager = manage(() => workspace, emitter);
      await manager.start(startPayload('s-done'));
      await until(() => seen.done.length === 1);
      const doneBranch = seen.done[0]?.branch ?? '';

      useAgent('hang');
      await manager.start(startPayload('s-live'));

      await manager.disposeAll();

      expect(seen.done.map((d) => [d.sessionId, d.status])).toEqual([
        ['s-done', 'completed'],
        ['s-live', 'cancelled'],
      ]);
      // Both checkout dirs are gone …
      const { stdout: worktrees } = await git(repo, ['worktree', 'list', '--porcelain']);
      expect(worktrees).not.toContain('s-done');
      expect(worktrees).not.toContain('s-live');
      // … but the finished session's branch — the committed work — is still there.
      const { stdout } = await git(repo, ['branch', '--list', doneBranch]);
      expect(stdout.trim()).toContain(doneBranch);
    });
  });
});
