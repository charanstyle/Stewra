import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertGitRepo, createSessionWorktree, worktreeDiff } from '../core/workspace.js';

const execFileAsync = promisify(execFile);

/** Real git, real filesystem — no mocks. A worktree that "works" against a fake git tells us nothing. */
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

describe('workspace (git worktree isolation)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'stewra-ws-test-'));
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@stewra.local']);
    await git(repo, ['config', 'user.name', 'Stewra Test']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'initial']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  });

  it('rejects a directory that is not a git repo', async () => {
    const notRepo = await mkdtemp(join(tmpdir(), 'stewra-notrepo-'));
    try {
      await expect(assertGitRepo(notRepo)).rejects.toThrow(/not a git repository/);
    } finally {
      await rm(notRepo, { recursive: true, force: true });
    }
  });

  it('creates an isolated worktree on a fresh branch from HEAD', async () => {
    const wt = await createSessionWorktree(repo, 'sess-abc-123');
    try {
      expect(wt.branch).toBe('stewra/run/sess-abc-123');
      expect(wt.baseSha).toMatch(/^[0-9a-f]{40}$/);
      // The checkout exists and carries the base content.
      expect((await stat(wt.path)).isDirectory()).toBe(true);
      expect(await readFile(join(wt.path, 'README.md'), 'utf8')).toBe('base\n');
    } finally {
      await wt.cleanup(true);
    }
  });

  it('contains edits inside the worktree — the main checkout is untouched', async () => {
    const wt = await createSessionWorktree(repo, 'sess-isolate');
    try {
      await writeFile(join(wt.path, 'new-file.txt'), 'agent wrote this\n');
      await writeFile(join(wt.path, 'README.md'), 'base\nmodified by agent\n');

      // The user's main working tree sees none of it.
      await expect(stat(join(repo, 'new-file.txt'))).rejects.toThrow();
      expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('base\n');

      // The diff reflects what the agent did, including the untracked new file (intent-to-add).
      const diff = await worktreeDiff(wt);
      expect(diff).toContain('new-file.txt');
      expect(diff).toContain('modified by agent');
    } finally {
      await wt.cleanup(true);
    }
  });

  it('cleanup removes the worktree directory', async () => {
    const wt = await createSessionWorktree(repo, 'sess-cleanup');
    await stat(wt.path); // exists now
    await wt.cleanup(true);
    await expect(stat(wt.path)).rejects.toThrow();
  });
});
