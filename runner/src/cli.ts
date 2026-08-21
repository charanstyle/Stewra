#!/usr/bin/env node
import { hostname } from 'node:os';
import type { RunnerHelloPayload } from '@stewra/shared-types';
import { loadRunnerConfig } from './config.js';
import { detectHarnesses, detectWorkspaces } from './core/capabilities.js';
import {
  CREDENTIAL_HOST,
  configureGitCredentialHelper,
  formatCredentialAnswer,
  parseCredentialRequest,
} from './core/gitCredentialHelper.js';
import { readHostIdentity } from './core/hostIdentity.js';
import { fetchGitCredentials } from './core/hostedApi.js';
import { StewraRunnerClient } from './core/stewraRunnerClient.js';
import { clearToken, hostedDeviceToken, loadToken, saveToken } from './core/tokenStore.js';
import { VERSION } from './version.js';

/**
 * The runner's entry point.
 *
 *   stewra-runner pair <code>       Trade a pairing code (minted in the Stewra web app) for a device token.
 *   stewra-runner run               Hold the socket open, announce capabilities, host coding sessions.
 *   stewra-runner git-credential    A git credential helper (hosted runners only). Invoked BY git.
 *   stewra-runner --version         Print the version.
 *
 * After `pair`, `run` connects, reports which coding harnesses and workspaces this machine has, shows
 * up (online) in the web app, and hosts full ACP coding sessions — streaming updates, permission
 * prompts, per-session git worktrees, and push/PR follow-through.
 *
 * A Stewra-HOSTED runner skips `pair` entirely — Stewra provisioned the container and injected its device
 * token — and additionally serves `git-credential`, so git inside that container authenticates with a
 * short-lived GitHub App token minted per operation instead of anything stored on its disk.
 */

/** What this machine calls itself, overridable so two machines with the same hostname stay distinct. */
function deviceName(): string {
  const fromEnv = process.env['STEWRA_RUNNER_DEVICE_NAME'];
  const name = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : hostname();
  return name.slice(0, 64);
}

async function runPair(code: string): Promise<void> {
  const config = loadRunnerConfig(process.env, VERSION);
  const client = new StewraRunnerClient(config);
  const token = await client.claimToken(code, deviceName(), process.platform);
  await saveToken(token);
  process.stderr.write(`Stewra Runner: paired as "${deviceName()}". You can now run: stewra-runner run\n`);
}

/**
 * The git credential helper protocol, for hosted runners.
 *
 * git spawns this process per operation, writes `key=value` lines on stdin terminated by a blank line,
 * and reads the same shape back. Only `get` does anything: `store` and `erase` are correctly no-ops
 * because there is nothing to store — every token is minted fresh and expires within the hour.
 *
 * Every failure exits non-zero with a message on stderr. A credential helper that stays silent on failure
 * makes git fall through to another helper or to an interactive prompt, so the user would see a hang or a
 * confusing "authentication failed" instead of the real cause.
 */
async function runGitCredential(operation: string | undefined): Promise<void> {
  if (operation !== 'get') {
    // `store` and `erase` are part of the protocol and must succeed silently; anything else is a misuse.
    if (operation === 'store' || operation === 'erase') return;
    process.stderr.write(`Stewra Runner: unknown git credential operation "${operation ?? ''}"\n`);
    process.exitCode = 2;
    return;
  }

  const token = hostedDeviceToken();
  if (token === null) {
    process.stderr.write(
      'Stewra Runner: git-credential is only available on a Stewra-hosted runner. On your own machine, ' +
        'git uses your own credentials.\n',
    );
    process.exitCode = 1;
    return;
  }

  const host = parseCredentialRequest(await readStdin()).get('host');
  if (host !== undefined && host !== CREDENTIAL_HOST) {
    // Nothing to say about another host. Exiting 0 with no output is how a helper declines: git moves on
    // to the next helper rather than treating it as an error.
    return;
  }

  const config = loadRunnerConfig(process.env, VERSION);
  const credentials = await fetchGitCredentials(config, token);
  process.stdout.write(formatCredentialAnswer(credentials.username, credentials.token));
}

/** Drain stdin as text. Git closes the pipe after the request, so this terminates. */
async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function runConnect(): Promise<void> {
  const config = loadRunnerConfig(process.env, VERSION);
  const token = await loadToken();
  if (token === null) {
    process.stderr.write('Stewra Runner: not paired. Run: stewra-runner pair <code>\n');
    process.exitCode = 1;
    return;
  }

  const client = new StewraRunnerClient(config);
  const hosted = hostedDeviceToken() !== null;

  if (hosted) {
    // Before the first hello, because announcing capabilities is what CLONES the repositories, and a
    // private repo cannot be cloned until git knows how to ask Stewra for a token.
    await configureGitCredentialHelper();
  }

  // Which computer this is. Read once, at startup, where a failure stops the process instead of being
  // discovered later as a machine Stewra cannot place: `os` and the device name never could tell the
  // server that this runner and a Stewra Bridge are the same box. `null` means a platform we read no
  // identifier for — a known state, not a failure — and the runner runs on without it.
  const host = await readHostIdentity(process.platform);

  const helloProvider = async (): Promise<RunnerHelloPayload> => {
    const [harnesses, workspaces] = await Promise.all([
      detectHarnesses(),
      detectWorkspaces(hosted ? { config, token } : undefined),
    ]);
    return {
      appVersion: VERSION,
      os: process.platform,
      harnesses,
      workspaces,
      ...(host === null ? {} : { host }),
    };
  };

  client.connect(token, helloProvider, {
    onConnected: () => process.stderr.write('Stewra Runner: online.\n'),
    onDisconnected: () => process.stderr.write('Stewra Runner: offline (will retry).\n'),
    onRevoked: () => {
      process.stderr.write('Stewra Runner: this device was revoked. Wiping token and exiting.\n');
      void clearToken().finally(() => process.exit(0));
    },
    onUpdateAvailable: ({ latestVersion, downloadUrl }) => {
      // Notify-only by design: this binary never replaces itself. The user downloads the new build.
      process.stderr.write(
        [
          '',
          `Stewra Runner: a newer version is available (${VERSION} → ${latestVersion}).`,
          `  Download it from: ${downloadUrl}`,
          '  This runner keeps working in the meantime — it will not update itself.',
          '',
        ].join('\n'),
      );
    },
  });

  // Hold the process open; the socket keeps the event loop alive. Shut down cleanly on a signal.
  const shutdown = (): void => {
    client.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  switch (command) {
    case 'pair': {
      const code = argv[1];
      if (code === undefined || code.length === 0) {
        process.stderr.write('Usage: stewra-runner pair <code>\n');
        process.exitCode = 2;
        return;
      }
      await runPair(code);
      return;
    }
    case 'run':
      await runConnect();
      return;
    case 'git-credential':
      // Invoked by git, not by a human: git appends the operation it wants to the configured command.
      await runGitCredential(argv[1]);
      return;
    default:
      process.stderr.write('Usage: stewra-runner <pair <code> | run> [--version]\n');
      process.exitCode = command === undefined ? 1 : 2;
      return;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`Stewra Runner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
