import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectWorkspaces } from '../core/capabilities.js';

const execFileAsync = promisify(execFile);

/**
 * `STEWRA_RUNNER_WORKSPACE_ROOTS`: a machine declares the directory its checkouts live under, and every
 * depth-1 git worktree root beneath it is reported. Which checkout belongs to which project is the
 * server's knowledge. Real directories and real `git init`, because "is a git worktree root" is git's
 * answer, not ours.
 */
describe('workspace roots', () => {
  let scratch: string;
  const saved = {
    mode: process.env['STEWRA_RUNNER_WORKSPACE_MODE'],
    roots: process.env['STEWRA_RUNNER_WORKSPACE_ROOTS'],
    list: process.env['STEWRA_RUNNER_WORKSPACES'],
  };

  async function gitRepo(dir: string): Promise<void> {
    await execFileAsync('git', ['init', '-q', '-b', 'main', dir]);
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'stewra-roots-'));
    delete process.env['STEWRA_RUNNER_WORKSPACE_MODE'];
    delete process.env['STEWRA_RUNNER_WORKSPACE_ROOTS'];
    delete process.env['STEWRA_RUNNER_WORKSPACES'];
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
    for (const [key, value] of [
      ['STEWRA_RUNNER_WORKSPACE_MODE', saved.mode],
      ['STEWRA_RUNNER_WORKSPACE_ROOTS', saved.roots],
      ['STEWRA_RUNNER_WORKSPACES', saved.list],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reports every depth-1 git checkout under a root, and nothing else', async () => {
    const root = join(scratch, 'projects');
    await mkdir(root);
    await gitRepo(join(root, 'Stewra'));
    await gitRepo(join(root, 'product_advisor'));
    await mkdir(join(root, 'not-a-repo')); // a plain folder
    await mkdir(join(root, '.hidden')); // dotfolders are never scanned
    await gitRepo(join(root, '.hidden'));
    await writeFile(join(root, 'notes.txt'), 'x'); // a file
    await mkdir(join(root, 'nested'));
    await gitRepo(join(root, 'nested', 'deeper')); // depth 2 — not reported
    process.env['STEWRA_RUNNER_WORKSPACE_ROOTS'] = root;

    const workspaces = await detectWorkspaces();

    expect(workspaces.map((w) => w.name)).toEqual(['Stewra', 'product_advisor']);
    expect(workspaces.every((w) => w.id.startsWith('ws_'))).toBe(true);
    expect(workspaces[0]?.path).toBe(join(root, 'Stewra'));
  });

  it('combines roots with explicitly listed directories, without duplicates', async () => {
    const root = join(scratch, 'projects');
    await mkdir(root);
    await gitRepo(join(root, 'Stewra'));
    const elsewhere = join(scratch, 'elsewhere');
    await gitRepo(elsewhere);
    process.env['STEWRA_RUNNER_WORKSPACE_ROOTS'] = root;
    // The listed entry overlaps a scanned one: reported once.
    process.env['STEWRA_RUNNER_WORKSPACES'] = `${join(root, 'Stewra')}:${elsewhere}`;

    const workspaces = await detectWorkspaces();

    expect(workspaces.map((w) => w.path).sort()).toEqual([join(root, 'Stewra'), elsewhere].sort());
  });

  it('reports nothing for a root that is not there — the unmounted-volume case — and does not throw', async () => {
    const present = join(scratch, 'present');
    await mkdir(present);
    await gitRepo(join(present, 'repo'));
    process.env['STEWRA_RUNNER_WORKSPACE_ROOTS'] = `${join(scratch, 'Volumes', 'gone')}:${present}`;

    const workspaces = await detectWorkspaces();

    expect(workspaces.map((w) => w.name)).toEqual(['repo']);
  });

  it('declares nothing when neither variable is set — no guessed home directory', async () => {
    await expect(detectWorkspaces()).resolves.toEqual([]);
  });
});
