import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import type { RunnerHarnessId, RunnerHarnessInfo, RunnerWorkspace } from '@stewra/shared-types';
import type { RunnerConfig } from '../config.js';
import { harnessCommand } from './harnessCommand.js';
import { fetchHostedWorkspaces } from './hostedApi.js';
import { describeGitDir, ensureClone } from './workspace.js';

const execFileAsync = promisify(execFile);

/** True only for "the executable does not exist" — the one failure that means a harness is absent. */
function isNotInstalled(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  const { code } = err;
  return code === 'ENOENT';
}

/**
 * Probe one harness: can this machine actually LAUNCH it, and at what version?
 *
 * The probe must ask about the command a session really spawns — the ACP adapter from
 * `harnessCommand()` — not the binary a human types interactively. Those differ for Claude Code and
 * Codex (`claude-agent-acp` / `codex-acp`), so probing `claude --version` reported
 * `claude-code: available` on a machine with no adapter installed. The server believed it, offered
 * the harness, and the session proposed against it died on `spawn claude-agent-acp ENOENT`.
 *
 * Never throws — absence is a valid result — but only ENOENT means absence. An adapter that exists
 * and simply has no `--version` flag exits non-zero, and calling that "unavailable" would hide a
 * perfectly usable harness.
 */
async function detectHarness(id: RunnerHarnessId): Promise<RunnerHarnessInfo> {
  const { command } = harnessCommand(id);
  try {
    const { stdout } = await execFileAsync(command, ['--version'], { timeout: 5_000 });
    const version = stdout.split('\n')[0]?.trim();
    return version !== undefined && version.length > 0
      ? { id, available: true, version: version.slice(0, 128) }
      : { id, available: true };
  } catch (err) {
    return isNotInstalled(err) ? { id, available: false } : { id, available: true };
  }
}

/** Probe every known harness concurrently. */
export async function detectHarnesses(): Promise<RunnerHarnessInfo[]> {
  return Promise.all(RUNNER_HARNESS_IDS.map(detectHarness));
}

/** A stable id for a workspace, derived from its absolute path so it survives restarts unchanged. */
function workspaceId(absPath: string): string {
  return `ws_${createHash('sha1').update(absPath).digest('hex').slice(0, 12)}`;
}

/**
 * What a `backend`-mode runner needs in order to ask Stewra which repositories it should be running
 * against: where the API is, and the device token that identifies this container to it.
 */
export interface BackendWorkspaceContext {
  readonly config: RunnerConfig;
  readonly token: string;
}

/**
 * The repositories this runner exposes for sessions. Three modes, chosen by `STEWRA_RUNNER_WORKSPACE_MODE`:
 *
 *   `local` (default) — a laptop: repos already on disk, from `STEWRA_RUNNER_WORKSPACES`.
 *   `clone`           — a cloud VM the user owns: repos cloned from `STEWRA_RUNNER_CLONE_REPOS`.
 *   `backend`         — a Stewra-hosted container: repos Stewra names, from the user's GitHub App install.
 *
 * It's the SAME binary in every mode — only where the code comes from differs — so everything downstream
 * (worktrees, sessions, push/PR) is unchanged. An unknown mode is a config mistake we surface loudly and
 * then treat as `local`, rather than crash the hello loop.
 */
export async function detectWorkspaces(context?: BackendWorkspaceContext): Promise<RunnerWorkspace[]> {
  // fallback-ok: 'local' names BEHAVIOUR (where repos come from), not a target the work is sent to.
  // Both modes act only on this machine, and an unrecognised value is reported loudly just below.
  const mode = (process.env['STEWRA_RUNNER_WORKSPACE_MODE'] ?? 'local').trim().toLowerCase(); // fallback-ok
  if (mode === 'clone') return detectClonedWorkspaces();
  if (mode === 'backend') {
    if (context === undefined) {
      // Not recoverable by falling back to `local`: this runner has no local checkouts to fall back TO,
      // and reporting zero workspaces would look to the user like an empty GitHub installation.
      throw new Error(
        'STEWRA_RUNNER_WORKSPACE_MODE=backend requires a device token, and this runner has none.',
      );
    }
    return detectBackendWorkspaces(context);
  }
  if (mode !== 'local') {
    process.stderr.write(`Stewra Runner: unknown STEWRA_RUNNER_WORKSPACE_MODE="${mode}" (expected local|clone|backend); using local\n`);
  }
  return detectLocalWorkspaces();
}

/**
 * Local repos from `STEWRA_RUNNER_WORKSPACES` — an OS-path-separated list of directories (e.g.
 * `/home/me/proj-a:/home/me/proj-b`). Empty when unset: a runner with no declared workspaces still pairs
 * and reports its harnesses; it simply has nowhere to run yet. Non-existent or non-directory entries are
 * dropped with a warning rather than reported — offering the server a workspace that isn't there would only
 * produce a session that fails on start. Each real git checkout is enriched with its remote + base branch.
 */
async function detectLocalWorkspaces(): Promise<RunnerWorkspace[]> {
  const raw = process.env['STEWRA_RUNNER_WORKSPACES'];
  if (raw === undefined || raw.trim().length === 0) return [];

  const entries = raw
    .split(/[:;,]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const workspaces: RunnerWorkspace[] = [];
  for (const entry of entries) {
    const absPath = resolve(entry);
    try {
      const info = await stat(absPath);
      if (!info.isDirectory()) {
        process.stderr.write(`Stewra Runner: skipping workspace (not a directory): ${absPath}\n`);
        continue;
      }
      workspaces.push({ id: workspaceId(absPath), name: basename(absPath), path: absPath, ...(await describeGitDir(absPath)) });
    } catch {
      process.stderr.write(`Stewra Runner: skipping workspace (does not exist): ${absPath}\n`);
    }
  }
  return workspaces;
}

/** Where cloud-VM clones live. Overridable so it can be a mounted, persistent volume; a data-dir default. */
function cloneRoot(): string {
  const override = process.env['STEWRA_RUNNER_WORKSPACE_ROOT'];
  return override !== undefined && override.trim().length > 0
    ? resolve(override.trim())
    : join(homedir(), '.stewra-runner', 'workspaces');
}

/**
 * Hand out a unique on-disk directory name per repo. Two distinct URLs whose tail is the same name (a
 * fork, the same repo on a different host, two owners' `api`) must not collide on disk and silently
 * become one workspace, so the second and later claimants get a numeric suffix.
 */
function dirNamer(): (base: string) => string {
  const used = new Map<string, number>();
  return (base: string): string => {
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  };
}

/** A filesystem-safe directory name from a clone URL's tail, e.g. `.../my-repo.git` -> `my-repo`. */
function repoDirName(url: string): string {
  const tail = url.replace(/\.git$/i, '').replace(/[/:]+$/, '').split(/[/:]/).pop() ?? '';
  const cleaned = tail.replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned.length > 0 ? cleaned : 'repo';
}

/**
 * Cloud-VM repos from `STEWRA_RUNNER_CLONE_REPOS` — a whitespace/comma-separated list of git URLs the runner
 * clones into its workspace root using the MACHINE'S own credentials. A URL that fails to clone/fetch is
 * dropped with a loud warning (not fatal) so one bad repo doesn't stop the runner exposing the others.
 */
async function detectClonedWorkspaces(): Promise<RunnerWorkspace[]> {
  const raw = process.env['STEWRA_RUNNER_CLONE_REPOS'];
  if (raw === undefined || raw.trim().length === 0) {
    process.stderr.write('Stewra Runner: WORKSPACE_MODE=clone but STEWRA_RUNNER_CLONE_REPOS is empty; no workspaces to expose\n');
    return [];
  }

  const urls = raw.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const root = cloneRoot();
  const uniqueDirName = dirNamer();
  const workspaces: RunnerWorkspace[] = [];
  for (const url of urls) {
    const name = uniqueDirName(repoDirName(url));
    const dir = join(root, name);
    try {
      const cloned = await ensureClone(url, dir);
      workspaces.push({
        id: workspaceId(dir),
        name,
        path: dir,
        gitRemote: cloned.gitRemote,
        defaultBranch: cloned.defaultBranch,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Stewra Runner: skipping repo (clone/fetch failed): ${url} — ${reason}\n`);
    }
  }
  return workspaces;
}

/**
 * Stewra-hosted repos: ask the backend which repositories the user's GitHub App installation covers, then
 * clone each one exactly as `clone` mode does.
 *
 * The list is fetched at every boot instead of being frozen into the container's environment at provision
 * time, so adding a repository to the installation reaches this runner the next time it starts rather than
 * requiring a reprovision that would discard every clone.
 *
 * Cloning uses the git credential helper this binary installs in hosted mode, which mints a short-lived
 * installation token per operation — so nothing long-lived is written to the container's disk.
 *
 * A failure to reach the backend is fatal here, deliberately: reporting an empty workspace list would be
 * indistinguishable, in the web app, from a user who has installed the GitHub App on no repositories.
 * One is a fault to retry, the other is a thing to go fix — they must not look the same.
 */
async function detectBackendWorkspaces(context: BackendWorkspaceContext): Promise<RunnerWorkspace[]> {
  const specs = await fetchHostedWorkspaces(context.config, context.token);
  if (specs.length === 0) {
    process.stderr.write('Stewra Runner: no repositories in this account\'s GitHub App installation yet\n');
    return [];
  }

  const root = cloneRoot();
  const uniqueDirName = dirNamer();
  const workspaces: RunnerWorkspace[] = [];
  for (const spec of specs) {
    const dir = join(root, uniqueDirName(repoDirName(spec.cloneUrl)));
    try {
      const cloned = await ensureClone(spec.cloneUrl, dir);
      workspaces.push({
        // The backend's id (`owner/name`), not a path hash: it is stable across a container rebuild that
        // lands the same repo in a different directory, and it is what the user sees named in the app.
        id: spec.id,
        name: spec.name,
        path: dir,
        gitRemote: cloned.gitRemote,
        defaultBranch: cloned.defaultBranch,
      });
    } catch (error) {
      // One unreachable repo must not cost the user every other one — but it IS reported, because a
      // workspace silently missing from the picker is the hardest kind of failure to diagnose.
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Stewra Runner: skipping repo (clone/fetch failed): ${spec.id} — ${reason}\n`);
    }
  }
  return workspaces;
}
