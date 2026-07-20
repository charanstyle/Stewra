#!/usr/bin/env node
import { hostname } from 'node:os';
import type { RunnerHelloPayload } from '@stewra/shared-types';
import { loadRunnerConfig } from './config.js';
import { detectHarnesses, detectWorkspaces } from './core/capabilities.js';
import { StewraRunnerClient } from './core/stewraRunnerClient.js';
import { clearToken, loadToken, saveToken } from './core/tokenStore.js';

/**
 * The runner's entry point.
 *
 *   stewra-runner pair <code>   Trade a pairing code (minted in the Stewra web app) for a device token.
 *   stewra-runner run           Hold the socket open, announce capabilities, host sessions (Phase 2).
 *   stewra-runner --version     Print the version.
 *
 * Phase 1 covers pairing + registration: after `pair`, `run` connects, reports which coding harnesses and
 * workspaces this machine has, and the machine shows up (online) in the web app. Session execution over
 * ACP arrives in Phase 2.
 */
const VERSION = '0.1.0';

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

async function runConnect(): Promise<void> {
  const config = loadRunnerConfig(process.env, VERSION);
  const token = await loadToken();
  if (token === null) {
    process.stderr.write('Stewra Runner: not paired. Run: stewra-runner pair <code>\n');
    process.exitCode = 1;
    return;
  }

  const client = new StewraRunnerClient(config);

  const helloProvider = async (): Promise<RunnerHelloPayload> => {
    const [harnesses, workspaces] = await Promise.all([detectHarnesses(), detectWorkspaces()]);
    return { appVersion: VERSION, os: process.platform, harnesses, workspaces };
  };

  client.connect(token, helloProvider, {
    onConnected: () => process.stderr.write('Stewra Runner: online.\n'),
    onDisconnected: () => process.stderr.write('Stewra Runner: offline (will retry).\n'),
    onRevoked: () => {
      process.stderr.write('Stewra Runner: this device was revoked. Wiping token and exiting.\n');
      void clearToken().finally(() => process.exit(0));
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
