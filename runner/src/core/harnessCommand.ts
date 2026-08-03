import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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

/** The env var that overrides a harness's ACP launch command. Exported so failure messages can name it. */
export function acpEnvKey(id: RunnerHarnessId): string {
  return `STEWRA_RUNNER_ACP_${id.toUpperCase().replace(/-/g, '_')}`;
}

export function harnessCommand(id: RunnerHarnessId): HarnessCommand {
  const override = process.env[acpEnvKey(id)];
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
 * Where a HOSTED runner finds the provider logins Stewra wrote into its home volume — one file per
 * harness, owner-readable only. Overridable for tests and for an operator who mounts them elsewhere.
 *
 * Files rather than environment variables, for two reasons. A container's environment is visible to
 * anyone who can run `docker inspect` on the host, whereas a file inside the volume is not; and a login
 * that expires (a `claude setup-token` lasts about a year) can be replaced by rewriting one file,
 * without recreating the container and losing every cloned repository with it.
 */
function credentialsDir(): string {
  const override = process.env['STEWRA_RUNNER_CREDENTIALS_DIR'];
  return override !== undefined && override.trim().length > 0
    ? resolve(override.trim())
    : join(homedir(), '.stewra-runner', 'credentials');
}

/**
 * Which environment variable each harness reads its provider login from.
 *
 * `claude-code` is absent here because it has no single answer — see `claudeCredentialVar` below.
 *
 * `codex` is deliberately absent rather than guessed. A slot written for it is a loud failure below, not
 * a silently-ignored credential that would surface later as an unexplained authentication error mid-session.
 */
const CREDENTIAL_ENV_VAR: Partial<Record<RunnerHarnessId, string>> = {
  'gemini-cli': 'GEMINI_API_KEY',
};

/**
 * The two logins the `claude` CLI accepts, and the variable each is read from.
 *
 * A user may paste either: a long-lived OAuth token from `claude setup-token` (`sk-ant-oat…`), which
 * spends their Claude subscription, or a console API key (`sk-ant-api…`), which is metered per token.
 * The CLI reads these from DIFFERENT variables, so the kind cannot be ignored — putting an API key in
 * `CLAUDE_CODE_OAUTH_TOKEN` authenticates as nothing, and the CLI reports it as a generic auth failure
 * mid-session, long after the paste that caused it.
 *
 * Verified end-to-end: `claude-agent-acp` spreads its own `process.env` into the environment it hands the
 * Claude Agent SDK, which passes it to the `claude` CLI, so the variable set here is the one the CLI
 * authenticates with.
 */
const CLAUDE_CREDENTIAL_VARS: readonly { readonly prefix: string; readonly varName: string }[] = [
  { prefix: 'sk-ant-oat', varName: 'CLAUDE_CODE_OAUTH_TOKEN' },
  { prefix: 'sk-ant-api', varName: 'ANTHROPIC_API_KEY' },
];

/**
 * Resolve which variable a pasted Claude login belongs in, by its form.
 *
 * An unrecognised form is a hard failure rather than a default into one variable or the other. Guessing
 * would spend the wrong account when it happened to work, and produce an unexplainable auth error when
 * it did not; naming the two accepted forms at spawn time points straight at the fix.
 */
function claudeCredentialVar(secret: string): string {
  const match = CLAUDE_CREDENTIAL_VARS.find((candidate) => secret.startsWith(candidate.prefix));
  if (match === undefined) {
    throw new Error(
      'The Claude Code login supplied is not a recognised credential: expected a long-lived OAuth token ' +
        'from `claude setup-token` (starts with "sk-ant-oat") or an Anthropic API key (starts with ' +
        '"sk-ant-api"). Re-paste the credential — running the session would fail to authenticate.',
    );
  }
  return match.varName;
}

/** Read a harness's credential slot, or null when the user has not supplied a login for it. */
async function readCredentialSlot(id: RunnerHarnessId): Promise<string | null> {
  try {
    const secret = (await readFile(join(credentialsDir(), id), 'utf8')).trim();
    return secret.length > 0 ? secret : null;
  } catch {
    // No slot file is the normal "this harness has no login yet" state, not an error: a runner can be
    // provisioned with no credentials at all and still clone, run git, and report its capabilities.
    return null;
  }
}

/**
 * The environment a harness subprocess inherits.
 *
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are STRIPPED for Claude Code so the adapter falls back to the
 * user's Claude Code subscription login instead of billing a raw API key — the same choice the backend's
 * `ClaudeCliModelClient` makes. A runner is the user's own machine; it should spend the user's subscription,
 * not a key that might be sitting in the environment for something else. A key the user PASTED is a
 * different matter — that is a stated choice rather than an accident of the environment, and it is
 * honoured below.
 *
 * On a HOSTED runner the login arrives as a credential slot and becomes the harness's provider variable.
 * The slot wins over an inherited variable of the same name: the user's stated login is the authority on a
 * machine Stewra runs, over whatever the image happened to be built with.
 */
export async function harnessEnv(id: RunnerHarnessId): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  if (id === 'claude-code') {
    delete env['ANTHROPIC_API_KEY'];
    delete env['ANTHROPIC_AUTH_TOKEN'];
  }

  const secret = await readCredentialSlot(id);
  if (secret !== null) {
    // Resolved AFTER the strip above, so a user-supplied API key is honoured while an ambient one is not.
    const varName = id === 'claude-code' ? claudeCredentialVar(secret) : CREDENTIAL_ENV_VAR[id];
    if (varName === undefined) {
      throw new Error(
        `A provider login was supplied for ${id}, but this runner does not know how to pass one to it. ` +
          'Remove the credential or use a supported harness — running the session would fail to authenticate.',
      );
    }
    env[varName] = secret;
  }
  return env;
}
