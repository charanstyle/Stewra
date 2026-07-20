import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
/** A push/PR reaches the network, so it needs a far more generous cap than a local plumbing command. */
const GIT_NETWORK_TIMEOUT_MS = 120_000;
/** A clone/fetch can pull a lot of history over the network, so it gets the most generous cap of all. */
const GIT_CLONE_TIMEOUT_MS = 600_000;

async function git(cwd: string, args: readonly string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, timeout });
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

/** True when the error is a "command not found" — the shape `execFile` throws for a missing binary. */
function isCommandNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && Reflect.get(error, 'code') === 'ENOENT';
}

/** The outcome of committing a session's work to its branch. */
export interface WorktreeCommit {
  /** False when the worktree had nothing to commit (agent made no change, or already committed itself). */
  readonly committed: boolean;
  /** The branch's HEAD after the attempt — advanced if we committed, else the branch's existing tip. */
  readonly headSha: string;
}

/**
 * Commit everything the session changed onto its branch, so the work becomes a reviewable, pushable object
 * rather than loose edits in a worktree that a later cleanup could drop.
 *
 * Idempotent-ish: if the agent already committed (or changed nothing), there's nothing to add and we simply
 * report the branch's current tip with `committed: false`. A repo lacking a configured `user.name`/`.email`
 * still commits — we pass a runner identity via `-c` rather than fail a completed session on git etiquette.
 */
export async function commitWorktree(worktree: Worktree, message: string): Promise<WorktreeCommit> {
  await git(worktree.path, ['add', '--all']);
  const staged = await git(worktree.path, ['status', '--porcelain']);
  if (staged.length === 0) {
    return { committed: false, headSha: await git(worktree.path, ['rev-parse', 'HEAD']) };
  }
  await git(worktree.path, [
    '-c', 'user.name=Stewra Runner',
    '-c', 'user.email=runner@stewra.local',
    'commit', '--no-verify', '-m', message,
  ]);
  return { committed: true, headSha: await git(worktree.path, ['rev-parse', 'HEAD']) };
}

/** Where a session's branch landed when pushed. */
export interface WorktreePush {
  readonly remote: string;
  readonly remoteUrl: string;
  readonly ref: string;
}

/**
 * Push the session's branch to a remote using the MACHINE'S own git credentials — the runner is the user's
 * box, so its git already knows how to authenticate; Stewra never handles a token. Fails loud when the repo
 * has no such remote (a local-only checkout) rather than silently doing nothing, so the UI can say so.
 *
 * The refspec is explicit (`branch:branch`) and `--force-with-lease` guards a re-push: it updates the remote
 * branch only if it still points where we last saw it, so a re-run can't clobber someone else's push.
 */
export async function pushWorktree(worktree: Worktree, remote = 'origin'): Promise<WorktreePush> {
  let remoteUrl: string;
  try {
    remoteUrl = await git(worktree.path, ['remote', 'get-url', remote]);
  } catch {
    throw new Error(`no_remote: workspace has no "${remote}" remote to push to`);
  }
  await git(
    worktree.path,
    ['push', '--force-with-lease', '--set-upstream', remote, `${worktree.branch}:${worktree.branch}`],
    GIT_NETWORK_TIMEOUT_MS,
  );
  return { remote, remoteUrl, ref: worktree.branch };
}

/** The pull request a session's branch opened. */
export interface WorktreePr {
  readonly url: string;
}

/**
 * Open a pull request for the session's branch via `gh` — the machine's GitHub CLI, using its own auth. We
 * shell to `gh` (not a stored token) for the same reason we push with local git: the credential belongs to
 * the user's machine, never to Stewra. Fails loud with `gh_missing` when the CLI isn't installed so the UI
 * can tell the user what to install, rather than hanging or guessing an API path.
 */
export async function openPullRequest(
  worktree: Worktree,
  opts: { title: string; body: string; base?: string },
): Promise<WorktreePr> {
  const args = ['pr', 'create', '--head', worktree.branch, '--title', opts.title, '--body', opts.body];
  if (opts.base !== undefined && opts.base.length > 0) args.push('--base', opts.base);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('gh', args, { cwd: worktree.path, timeout: GIT_NETWORK_TIMEOUT_MS }));
  } catch (error) {
    if (isCommandNotFound(error)) {
      throw new Error('gh_missing: the GitHub CLI (gh) is not installed on this machine');
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
  // `gh pr create` prints the PR URL as its last non-empty line; fall back to the whole output if it changes.
  const url = stdout.trim().split('\n').map((l) => l.trim()).filter((l) => l.startsWith('http')).at(-1);
  return { url: url ?? stdout.trim() };
}

// ── Cloud-VM workspaces (Phase 4): the runner clones repos it will run against ──────────────────────────

/** True when `dir` is the top of a git working tree — used to decide clone-vs-fetch. */
async function isGitWorktreeRoot(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).length > 0;
  } catch {
    return false;
  }
}

/**
 * The clone's default branch: `origin/HEAD` when set (it always is right after a clone), else the branch
 * that got checked out. Never guesses a name — a repo with no determinable default (a detached HEAD with no
 * origin/HEAD) fails loud rather than silently branching sessions off the wrong base.
 */
async function resolveDefaultBranch(dir: string): Promise<string> {
  try {
    const short = (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '');
    if (short.length > 0) return short;
  } catch {
    // origin/HEAD not set — fall through to the checked-out branch.
  }
  const head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.length === 0 || head === 'HEAD') throw new Error(`cannot determine default branch: ${dir}`);
  return head;
}

/** A workspace's remote + base branch, best-effort — used to enrich the picker (never fatal for local dirs). */
export interface GitDirInfo {
  readonly gitRemote?: string;
  readonly defaultBranch?: string;
}

/** Describe a workspace dir's origin + default branch; an empty object when it isn't a git repo at all. */
export async function describeGitDir(dir: string): Promise<GitDirInfo> {
  if (!(await isGitWorktreeRoot(dir))) return {};
  const info: { gitRemote?: string; defaultBranch?: string } = {};
  try { info.gitRemote = await git(dir, ['remote', 'get-url', 'origin']); } catch { /* no origin remote */ }
  try { info.defaultBranch = await resolveDefaultBranch(dir); } catch { /* detached / indeterminate */ }
  return info;
}

/** A repo the runner has cloned locally and is ready to run sessions against. */
export interface ClonedWorkspace {
  readonly path: string;
  readonly gitRemote: string;
  readonly defaultBranch: string;
}

/**
 * Ensure a working clone of `url` exists at `dir`, then report its remote + default branch.
 *
 * This is the cloud-VM counterpart to a laptop's local checkout: the same runner binary, but it fetches the
 * code instead of finding it already on disk. Credentials are the MACHINE'S own — a `GITHUB_TOKEN` in git's
 * credential store, a deploy key, or `gh auth` on the VM — never a token from Stewra, exactly as push/PR do.
 * `GIT_TERMINAL_PROMPT=0` turns a missing or expired credential into a loud, immediate failure instead of a
 * hung interactive prompt, because a headless VM has no human to answer one.
 *
 * Clone when absent; otherwise re-point origin at `url` and fetch, so a long-lived runner picks up upstream
 * commits between sessions without anyone reprovisioning it.
 */
export async function ensureClone(url: string, dir: string): Promise<ClonedWorkspace> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (await isGitWorktreeRoot(dir)) {
    await execFileAsync('git', ['-C', dir, 'remote', 'set-url', 'origin', url], { env, timeout: GIT_TIMEOUT_MS });
    await execFileAsync('git', ['-C', dir, 'fetch', '--prune', 'origin'], { env, timeout: GIT_CLONE_TIMEOUT_MS });
  } else {
    await mkdir(dirname(dir), { recursive: true });
    // Clear a partial/stale dir from a crashed prior clone so the retry is clean rather than "already exists".
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await execFileAsync('git', ['clone', url, dir], { env, timeout: GIT_CLONE_TIMEOUT_MS });
  }
  const gitRemote = await git(dir, ['remote', 'get-url', 'origin']);
  const defaultBranch = await resolveDefaultBranch(dir);
  return { path: dir, gitRemote, defaultBranch };
}
