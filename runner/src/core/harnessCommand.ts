import type { RunnerHarnessId } from '@stewra/shared-types';

/** The command that launches a harness in ACP mode (JSON-RPC over stdio), and its fixed args. */
export interface HarnessCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * How to start each harness as an ACP agent.
 *
 * The ACP entrypoint is NOT always the same binary a user types interactively: Claude Code and Codex are
 * driven through dedicated adapter binaries (`claude-agent-acp`, `codex-acp`) that translate ACP to the
 * tool's own protocol, whereas Gemini speaks ACP natively behind a flag. These are the documented, current
 * launch commands (the older `@zed-industries/*` adapters were renamed to `@agentclientprotocol/*`).
 *
 * Each is overridable by env for a machine whose adapter lives off PATH or must be launched via a wrapper
 * (e.g. `STEWRA_RUNNER_ACP_CLAUDE_CODE="npx -y @agentclientprotocol/claude-agent-acp"`). We split the
 * override on whitespace — enough for "npx -y pkg" without pulling in a shell (and its injection surface).
 */
const DEFAULTS: Record<RunnerHarnessId, HarnessCommand> = {
  'claude-code': { command: 'claude-agent-acp', args: [] },
  codex: { command: 'codex-acp', args: [] },
  'gemini-cli': { command: 'gemini', args: ['--experimental-acp'] },
};

function envKey(id: RunnerHarnessId): string {
  return `STEWRA_RUNNER_ACP_${id.toUpperCase().replace(/-/g, '_')}`;
}

export function harnessCommand(id: RunnerHarnessId): HarnessCommand {
  const override = process.env[envKey(id)];
  if (override !== undefined && override.trim().length > 0) {
    const parts = override.trim().split(/\s+/).filter((p) => p.length > 0);
    const command = parts[0];
    if (command !== undefined) {
      return { command, args: parts.slice(1) };
    }
  }
  return DEFAULTS[id];
}

/**
 * The environment a harness subprocess inherits.
 *
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are STRIPPED for Claude Code so the adapter falls back to the
 * user's Claude Code subscription login instead of billing a raw API key — the same choice the backend's
 * `ClaudeCliModelClient` makes. A runner is the user's own machine; it should spend the user's subscription,
 * not a key that might be sitting in the environment for something else.
 */
export function harnessEnv(id: RunnerHarnessId): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (id === 'claude-code') {
    delete env['ANTHROPIC_API_KEY'];
    delete env['ANTHROPIC_AUTH_TOKEN'];
  }
  return env;
}
