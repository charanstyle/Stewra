import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpSession } from '../core/acpClient.js';
import type { AcpPermissionPrompt, AcpUpdate } from '../core/acpClient.js';
import { acpEnvKey } from '../core/harnessCommand.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const ENV_KEY = acpEnvKey('gemini-cli');

/** Point the gemini-cli harness at the scripted fixture agent for this test. */
function useFakeAgent(scenario: string): void {
  process.env[ENV_KEY] = `${process.execPath} ${FIXTURE} ${scenario}`;
}

describe('AcpSession against a scripted ACP agent', () => {
  let cwd: string;
  let session: AcpSession | null = null;
  const savedEnv = process.env[ENV_KEY];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'stewra-acp-test-'));
  });

  afterEach(async () => {
    session?.dispose();
    session = null;
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
    await rm(cwd, { recursive: true, force: true });
  });

  const callbacks = (updates: AcpUpdate[], onPermission?: (p: AcpPermissionPrompt) => Promise<string | null>) => ({
    onUpdate: (update: AcpUpdate): void => {
      updates.push(update);
    },
    onPermission: onPermission ?? ((): Promise<string | null> => Promise.resolve(null)),
  });

  it('rejects a missing adapter binary with the PATH hint, naming the override variable', async () => {
    // The real failure this guards: spawn() does not throw for ENOENT, it emits 'error' later — and an
    // unhandled 'error' would take the whole runner down, not just this session.
    process.env[ENV_KEY] = 'stewra-definitely-not-installed-binary';
    session = new AcpSession('gemini-cli', cwd, callbacks([]));
    await expect(session.start()).rejects.toThrow(
      new RegExp(`not installed or not on PATH.*${ENV_KEY}`),
    );
  });

  it('maps the full sessionUpdate table, and drops what Stewra does not show', async () => {
    useFakeAgent('happy');
    const updates: AcpUpdate[] = [];
    session = new AcpSession('gemini-cli', cwd, callbacks(updates));
    await session.start();

    const stopReason = await session.prompt('go');

    expect(stopReason).toBe('end_turn');
    // In order — and note the absences: the non-text (image) chunk, the in_progress tool tick, and
    // nothing after 'plan' because unknown update kinds must be ignored, not crashed on.
    expect(updates).toEqual([
      { kind: 'agent-message', text: 'hello from the agent' },
      { kind: 'agent-thought', text: 'thinking…' },
      { kind: 'tool-call', tool: 'Read file', text: 'Read file' },
      { kind: 'tool-result', text: 'Read file' },
      { kind: 'tool-result' },
      { kind: 'status', text: 'updated plan' },
    ]);
  });

  it('relays a permission prompt and answers the harness with the chosen option', async () => {
    useFakeAgent('permission');
    const updates: AcpUpdate[] = [];
    const prompts: AcpPermissionPrompt[] = [];
    session = new AcpSession(
      'gemini-cli',
      cwd,
      callbacks(updates, (prompt) => {
        prompts.push(prompt);
        return Promise.resolve('yes');
      }),
    );
    await session.start();

    const stopReason = await session.prompt('do something risky');

    expect(stopReason).toBe('end_turn');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.title).toBe('Run a shell command');
    // NB: an out-of-enum kind cannot be tested over the wire — the client SDK validates the request
    // at the connection layer and rejects it before AcpSession runs, so toPermissionKind's
    // unknown-kind → allow_once fallback is defence in depth against future/looser SDKs.
    expect(prompts[0]?.options).toEqual([
      { id: 'yes', label: 'Allow once', kind: 'allow_once' },
      { id: 'no', label: 'Reject', kind: 'reject_once' },
      { id: 'always', label: 'Allow always', kind: 'allow_always' },
    ]);
    // The fixture echoes exactly what the harness received — proving the wire outcome, not just ours.
    expect(updates[0]?.text).toBe('outcome:{"outcome":"selected","optionId":"yes"}');
  });

  it('turns a null decision into an ACP cancellation', async () => {
    useFakeAgent('permission');
    const updates: AcpUpdate[] = [];
    session = new AcpSession('gemini-cli', cwd, callbacks(updates, () => Promise.resolve(null)));
    await session.start();

    const stopReason = await session.prompt('do something risky');

    expect(stopReason).toBe('cancelled');
    expect(updates[0]?.text).toBe('outcome:{"outcome":"cancelled"}');
  });

  it('cancel() makes a held-open turn come back with stopReason cancelled', async () => {
    useFakeAgent('hang');
    session = new AcpSession('gemini-cli', cwd, callbacks([]));
    await session.start();

    const turn = session.prompt('never answered');
    // Give the fixture a beat to receive the prompt before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.cancel();

    await expect(turn).resolves.toBe('cancelled');
  });
});
