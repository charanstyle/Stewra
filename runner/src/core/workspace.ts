import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * A per-session git worktree: the blast-radius container for one coding session.
 *
 * The runner has full access to the user's machine by design — it IS the user's machine. What contains the
 * damage a session can do is not a sandbox (there is none) but ISOLATION OF THE WORKING TREE: every session
 * gets its own worktree on its own branch, cut from a known base commit, so an agent's edits land somewhere
 * the user can review, diff, keep, or throw away — never silently on top of whatever they had checked out.
 *
 * A worktree (not a clone) because it shares the repo's object store: creation is near-instant and costs no
 * extra copy of history, while still giving a fully independent checkout and HEAD.
 */
export interface Worktree {
  /** Absolute path to the isolated checkout — this is the cwd the harness runs in. */
  readonly path: string;
  /** The branch this worktree is on (created fresh for the session). */
  readonly branch: string;
  /** The commit the branch was cut from, recorded so the final diff has an unambiguous base. */
  readonly baseSha: string;
  /** Remove the worktree. The branch is kept so committed work survives; pass `deleteBranch` to drop it. */
  cleanup(deleteBranch?: boolean): Promise<void>;
}

/** Git output is small here; cap it so a wedged git can never hang a session's setup forever. */
const GIT_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

/** A filesystem- and git-ref-safe branch/dir fragment derived from the server-minted session id. */
function safeFragment(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  // A ref can't be empty and can't end in a dot; fall back to a constant rather than produce an invalid ref.
  return cleaned.length > 0 ? cleaned.replace(/\.+$/, '') || 'session' : 'session';
}

/**
 * Confirm `repoPath` is the top of a real git working tree. A session that isn't rooted in a repo has no
 * base to branch from and no diff to show, so this fails loud rather than running an agent loose in a plain
 * directory.
 */
export async function assertGitRepo(repoPath: string): Promise<void> {
  let top: string;
  try {
    top = await git(repoPath, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(`not a git repository: ${repoPath}`);
  }
  if (top.length === 0) throw new Error(`not a git repository: ${repoPath}`);
}

/**
 * Create an isolated worktree for a session.
 *
 * `base` is the ref to branch from (e.g. the workspace's default branch); when omitted, the repo's current
 * HEAD is used. The base is resolved to a concrete SHA up front so the session's diff base can't shift under
 * it if the user checks out something else in the main worktree mid-session.
 */
export async function createSessionWorktree(
  repoPath: string,
  sessionId: string,
  base?: string,
): Promise<Worktree> {
  await assertGitRepo(repoPath);

  const baseSha = await git(repoPath, ['rev-parse', '--verify', `${base ?? 'HEAD'}^{commit}`]);
  const fragment = safeFragment(sessionId);
  const branch = `stewra/run/${fragment}`;

  const root = join(tmpdir(), 'stewra-runner', 'worktrees');
  await mkdir(root, { recursive: true });
  const path = join(root, fragment);
  // If a stale worktree dir from a crashed prior run is squatting the path, git's own add would fail
  // cryptically; clear it (and any dangling registration) first so a retry is clean.
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  await git(repoPath, ['worktree', 'prune']).catch(() => undefined);

  // -B (force-create/reset the branch) rather than -b so a re-run with the same session id doesn't die on
  // "branch already exists"; the worktree checkout is fresh either way.
  await git(repoPath, ['worktree', 'add', '-B', branch, path, baseSha]);

  const cleanup = async (deleteBranch = false): Promise<void> => {
    await git(repoPath, ['worktree', 'remove', '--force', path]).catch(() => undefined);
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    if (deleteBranch) await git(repoPath, ['branch', '-D', branch]).catch(() => undefined);
  };

  return { path, branch, baseSha, cleanup };
}

/**
 * The unified diff of everything a session changed, relative to its base commit — including not-yet-staged
 * edits and brand-new files (via an in-memory intent-to-add), so a preview reflects what the agent actually
 * did even when it never ran `git add`. Bounded by the caller before it goes on the wire.
 */
export async function worktreeDiff(worktree: Worktree): Promise<string> {
  await git(worktree.path, ['add', '--intent-to-add', '--all']).catch(() => undefined);
  return git(worktree.path, ['diff', worktree.baseSha]);
}
