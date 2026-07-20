import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertGitRepo,
  commitWorktree,
  createSessionWorktree,
  describeGitDir,
  ensureClone,
  pushWorktree,
  worktreeDiff,
} from '../core/workspace.js';

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

  it('commits the agent’s changes onto the session branch', async () => {
    const wt = await createSessionWorktree(repo, 'sess-commit');
    try {
      await writeFile(join(wt.path, 'feature.txt'), 'a real change\n');
      const result = await commitWorktree(wt, 'Stewra runner: add feature');
      expect(result.committed).toBe(true);
      expect(result.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.headSha).not.toBe(wt.baseSha); // the branch advanced past its base

      // The commit really landed on the branch, with the intended subject, and is empty-tree clean after.
      const { stdout: subject } = await execFileAsync('git', ['log', '-1', '--pretty=%s', wt.branch], { cwd: repo });
      expect(subject.trim()).toBe('Stewra runner: add feature');
      const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain'], { cwd: wt.path });
      expect(porcelain.trim()).toBe('');
    } finally {
      await wt.cleanup(true);
    }
  });

  it('reports committed:false when the agent changed nothing', async () => {
    const wt = await createSessionWorktree(repo, 'sess-nochange');
    try {
      const result = await commitWorktree(wt, 'Stewra runner: noop');
      expect(result.committed).toBe(false);
      expect(result.headSha).toBe(wt.baseSha); // branch still at base — nothing to commit
    } finally {
      await wt.cleanup(true);
    }
  });

  it('pushes the session branch to a real (local bare) remote', async () => {
    // A genuine remote — a bare repo on disk — so the push is real git over a real refspec, not a mock.
    const bare = await mkdtemp(join(tmpdir(), 'stewra-remote-'));
    await git(bare, ['init', '-q', '--bare']);
    await git(repo, ['remote', 'add', 'origin', bare]);

    const wt = await createSessionWorktree(repo, 'sess-push');
    try {
      await writeFile(join(wt.path, 'pushed.txt'), 'ship it\n');
      await commitWorktree(wt, 'Stewra runner: push me');
      const result = await pushWorktree(wt);
      expect(result.ref).toBe('stewra/run/sess-push');
      expect(result.remoteUrl).toBe(bare);

      // The branch really exists on the remote now.
      const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', bare, 'stewra/run/sess-push'], { cwd: repo });
      expect(stdout).toContain('refs/heads/stewra/run/sess-push');
    } finally {
      await wt.cleanup(true);
      await rm(bare, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails loud when pushing a workspace with no remote', async () => {
    const wt = await createSessionWorktree(repo, 'sess-noremote');
    try {
      await writeFile(join(wt.path, 'x.txt'), 'y\n');
      await commitWorktree(wt, 'Stewra runner: x');
      await expect(pushWorktree(wt)).rejects.toThrow(/no_remote/);
    } finally {
      await wt.cleanup(true);
    }
  });
});

describe('cloud-VM workspaces (clone mode)', () => {
  // `origin` stands in for the GitHub repo a cloud runner would clone. Cloning from a local path is real
  // git over a real transport — no network, no mocks — so it exercises the exact clone/fetch code paths.
  let origin: string;
  let dest: string;

  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), 'stewra-origin-'));
    await git(origin, ['init', '-q', '-b', 'main']);
    await git(origin, ['config', 'user.email', 'origin@stewra.local']);
    await git(origin, ['config', 'user.name', 'Stewra Origin']);
    await writeFile(join(origin, 'README.md'), 'base\n');
    await git(origin, ['add', '.']);
    await git(origin, ['commit', '-q', '-m', 'initial']);
    dest = await mkdtemp(join(tmpdir(), 'stewra-clone-root-'));
  });

  afterEach(async () => {
    await rm(origin, { recursive: true, force: true }).catch(() => undefined);
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
  });

  it('clones a repo and reports its remote + default branch', async () => {
    const dir = join(dest, 'repo');
    const cloned = await ensureClone(origin, dir);
    expect(cloned.path).toBe(dir);
    expect(cloned.gitRemote).toBe(origin);
    expect(cloned.defaultBranch).toBe('main');
    // A real checkout carrying the origin content — not an empty dir.
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('base\n');
  });

  it('is idempotent: a second call fetches new upstream commits instead of failing', async () => {
    const dir = join(dest, 'repo');
    await ensureClone(origin, dir);

    // Advance origin, then re-run: ensureClone must fetch (not choke on "already exists").
    await writeFile(join(origin, 'CHANGELOG.md'), 'v2\n');
    await git(origin, ['add', '.']);
    await git(origin, ['commit', '-q', '-m', 'second']);
    const { stdout: originHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: origin });

    await ensureClone(origin, dir);
    const { stdout: fetchedHead } = await execFileAsync('git', ['rev-parse', 'origin/main'], { cwd: dir });
    expect(fetchedHead.trim()).toBe(originHead.trim()); // the new commit really arrived
  });

  it('a cloned workspace runs a full session round-trip: worktree -> commit -> push back', async () => {
    const dir = join(dest, 'repo');
    const cloned = await ensureClone(origin, dir);

    // Exactly what a real session does: branch a worktree from the clone's default branch, edit, commit, push.
    const wt = await createSessionWorktree(cloned.path, 'sess-cloud', cloned.defaultBranch);
    try {
      await writeFile(join(wt.path, 'from-cloud.txt'), 'hello from a cloud runner\n');
      const commit = await commitWorktree(wt, 'Stewra runner: cloud change');
      expect(commit.committed).toBe(true);
      const push = await pushWorktree(wt);
      expect(push.remoteUrl).toBe(origin);

      // The branch really landed back on origin (the "GitHub" repo).
      const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', origin, 'stewra/run/sess-cloud'], { cwd: dir });
      expect(stdout).toContain('refs/heads/stewra/run/sess-cloud');
    } finally {
      await wt.cleanup(true);
    }
  });

  it('describeGitDir reports remote + branch for a checkout, and nothing for a plain dir', async () => {
    const dir = join(dest, 'repo');
    await ensureClone(origin, dir);
    const info = await describeGitDir(dir);
    expect(info.gitRemote).toBe(origin);
    expect(info.defaultBranch).toBe('main');

    const plain = await mkdtemp(join(tmpdir(), 'stewra-plain-'));
    try {
      expect(await describeGitDir(plain)).toEqual({});
    } finally {
      await rm(plain, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
