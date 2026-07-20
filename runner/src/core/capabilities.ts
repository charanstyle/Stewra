import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import type { RunnerHarnessId, RunnerHarnessInfo, RunnerWorkspace } from '@stewra/shared-types';

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
 * The repositories this runner exposes for sessions, from `STEWRA_RUNNER_WORKSPACES` — an OS-path-separated
 * list of directories (e.g. `/home/me/proj-a:/home/me/proj-b`). Empty when unset: a runner with no
 * declared workspaces still pairs and reports its harnesses; it simply has nowhere to run yet.
 *
 * Non-existent or non-directory entries are dropped with a warning rather than reported — offering the
 * server a workspace that isn't there would only produce a session that fails on start.
 */
export async function detectWorkspaces(): Promise<RunnerWorkspace[]> {
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
      workspaces.push({ id: workspaceId(absPath), name: basename(absPath), path: absPath });
    } catch {
      process.stderr.write(`Stewra Runner: skipping workspace (does not exist): ${absPath}\n`);
    }
  }
  return workspaces;
}
