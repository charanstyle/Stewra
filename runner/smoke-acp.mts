// Live smoke: drive the REAL claude-agent-acp adapter through AcpSession against a throwaway git repo,
// auto-approving permissions, and assert a real file write. Proves the ACP centerpiece end to end.
// Run: cd runner && npx tsx smoke-acp.mts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSessionWorktree } from './src/core/workspace.js';
import { AcpSession } from './src/core/acpClient.js';
import type { AcpPermissionPrompt, AcpUpdate } from './src/core/acpClient.js';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd });

// Fetch the adapter via npx so the smoke needs nothing pre-installed on PATH.
process.env['STEWRA_RUNNER_ACP_CLAUDE_CODE'] = 'npx -y @agentclientprotocol/claude-agent-acp';

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms)),
  ]);
}

async function main(): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'stewra-acp-smoke-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'smoke@stewra.local']);
  await git(repo, ['config', 'user.name', 'Stewra Smoke']);
  await writeFile(join(repo, 'README.md'), '# smoke repo\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);

  const worktree = await createSessionWorktree(repo, 'acp-smoke-1');
  console.log(`worktree: ${worktree.path} (branch ${worktree.branch})`);

  let sawAgentText = false;
  let sawPermission = false;

  const session = new AcpSession('claude-code', worktree.path, {
    onUpdate(u: AcpUpdate): void {
      if (u.kind === 'agent-message' && u.text) {
        sawAgentText = true;
        process.stdout.write(u.text);
      } else if (u.kind === 'tool-call') {
        console.log(`\n[tool-call] ${u.tool ?? ''}`);
      } else if (u.kind === 'tool-result') {
        console.log(`\n[tool-result] ${u.text ?? ''}`);
      }
    },
    async onPermission(p: AcpPermissionPrompt): Promise<string | null> {
      sawPermission = true;
      const pick =
        p.options.find((o) => o.kind === 'allow_always') ??
        p.options.find((o) => o.kind === 'allow_once') ??
        p.options[0];
      console.log(`\n[permission] "${p.title}" -> auto-allow "${pick?.label}"`);
      return pick?.id ?? null;
    },
  });

  try {
    console.log('starting ACP session (first run downloads the adapter via npx — may take a bit)…');
    await withTimeout(session.start(), 120_000, 'session.start');
    console.log('session started; prompting…');

    const stopReason = await withTimeout(
      session.prompt(
        "Create a file named hello.txt in the current directory containing exactly the text " +
          "'Hello from Stewra runner'. Use your file-writing tool. Then briefly confirm and stop.",
      ),
      180_000,
      'session.prompt',
    );
    console.log(`\n\n[stopReason] ${stopReason}`);

    const target = join(worktree.path, 'hello.txt');
    const exists = await stat(target).then(() => true).catch(() => false);
    const content = exists ? await readFile(target, 'utf8') : '';

    console.log('\n=== RESULTS ===');
    console.log(`  agent text streamed: ${sawAgentText}`);
    console.log(`  permission requested: ${sawPermission}`);
    console.log(`  hello.txt created:    ${exists}`);
    console.log(`  hello.txt content:    ${JSON.stringify(content)}`);

    const ok = exists && content.includes('Hello from Stewra runner');
    console.log(`\n== ${ok ? 'SMOKE PASSED' : 'SMOKE INCONCLUSIVE (see above)'} ==`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    session.dispose();
    await worktree.cleanup(true).catch(() => undefined);
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error('\nSMOKE ERROR:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
