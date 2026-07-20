import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import type { RunnerHarnessId, RunnerHarnessInfo, RunnerWorkspace } from '@stewra/shared-types';
import { describeGitDir, ensureClone } from './workspace.js';

const execFileAsync = promisify(execFile);

/**
 * The default binary each harness ships as. These are NAMES, not URLs or ports — the canonical command a
 * user types to run the tool — so a default is honest here. Each is still overridable by env for a runner
 * whose binaries live off PATH (e.g. `STEWRA_RUNNER_CLAUDE_CODE_PATH=/opt/claude/bin/claude`), and the
 * probe fails loud-but-locally (marks the harness unavailable) rather than guessing.
 */
const DEFAULT_BINARY: Record<RunnerHarnessId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  'gemini-cli': 'gemini',
};

function binaryFor(id: RunnerHarnessId): string {
  const override = process.env[`STEWRA_RUNNER_${id.toUpperCase().replace(/-/g, '_')}_PATH`];
  return override !== undefined && override.length > 0 ? override : DEFAULT_BINARY[id];
}

/** Probe one harness: is its binary runnable, and at what version? Never throws — absence is a valid result. */
async function detectHarness(id: RunnerHarnessId): Promise<RunnerHarnessInfo> {
  const binary = binaryFor(id);
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 5_000 });
    const version = stdout.split('\n')[0]?.trim();
    return version !== undefined && version.length > 0
      ? { id, available: true, version: version.slice(0, 128) }
      : { id, available: true };
  } catch {
    return { id, available: false };
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
 * The repositories this runner exposes for sessions. Two modes, chosen by `STEWRA_RUNNER_WORKSPACE_MODE`:
 *
 *   `local` (default) — a laptop: repos already on disk, from `STEWRA_RUNNER_WORKSPACES`.
 *   `clone`           — a cloud VM: repos the runner `git clone`s from `STEWRA_RUNNER_CLONE_REPOS`.
 *
 * It's the SAME binary either way — only where the code comes from differs — so everything downstream
 * (worktrees, sessions, push/PR) is unchanged. An unknown mode is a config mistake we surface loudly and
 * then treat as `local`, rather than crash the hello loop.
 */
export async function detectWorkspaces(): Promise<RunnerWorkspace[]> {
  const mode = (process.env['STEWRA_RUNNER_WORKSPACE_MODE'] ?? 'local').trim().toLowerCase();
  if (mode === 'clone') return detectClonedWorkspaces();
  if (mode !== 'local') {
    process.stderr.write(`Stewra Runner: unknown STEWRA_RUNNER_WORKSPACE_MODE="${mode}" (expected local|clone); using local\n`);
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
  const used = new Map<string, number>();
  const workspaces: RunnerWorkspace[] = [];
  for (const url of urls) {
    // Two distinct URLs whose tail is the same name (a fork, a different host) must not collide on disk.
    const base = repoDirName(url);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const name = seen === 0 ? base : `${base}-${seen}`;
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
