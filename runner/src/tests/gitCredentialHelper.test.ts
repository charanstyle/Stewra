import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialHelperCommand,
  formatCredentialAnswer,
  parseCredentialRequest,
} from '../core/gitCredentialHelper.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO_ROOT, 'dist', 'cli.js');

/**
 * The git credential helper, exercised the way git actually uses it.
 *
 * `git credential fill` is the real consumer: it reads the helper configuration, spawns the helper as a
 * subprocess, speaks the protocol on pipes, and parses what comes back. Driving the helper directly would
 * skip every part of that which can actually be wrong — the shell-quoting of the configured command, the
 * blank-line request terminator, the exact reply keys — so these tests go through git itself, against a
 * real HTTP server standing in for Stewra's backend.
 *
 * The server ENFORCES the contract rather than agreeing with whatever arrives: a request without the
 * device token is refused, exactly as the backend refuses it.
 */

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

describe('git credential helper (hosted runners)', () => {
  let server: Server;
  let baseUrl: string;
  let requests: RecordedRequest[];
  /** Set per test: what the backend should do with the next mint request. */
  let respond: (res: ServerResponse) => void;
  let home: string;

  const DEVICE_TOKEN = 'device-token-for-this-container';
  const MINTED = 'ghs-installation-token-minted-for-this-operation';

  beforeAll(async () => {
    // The helper is a SUBPROCESS git spawns, so it runs the built artifact, not the TypeScript sources.
    // Building here (rather than trusting whatever is in dist/) keeps the test honest about current code.
    await execFileAsync('npm', ['run', 'build'], { cwd: REPO_ROOT, timeout: 180_000 });

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
      });
      if (req.headers.authorization !== `Bearer ${DEVICE_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'That runner token is not valid.' }));
        return;
      }
      respond(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 200_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    requests = [];
    respond = (res): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: {
            username: 'x-access-token',
            token: MINTED,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      );
    };
    // An isolated HOME so the developer's own ~/.gitconfig — and its credential helpers — cannot
    // influence the result, and so nothing this test configures leaks into their machine.
    home = await mkdtemp(join(tmpdir(), 'stewra-credhelper-home-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /**
   * Run a process, write `input` to its stdin, and close it.
   *
   * `spawn` rather than `execFile`, because `execFile` has no `input` option: its stdin pipe is opened
   * and then never written to or closed, so a child that reads to end-of-input waits forever. The
   * credential helper does exactly that, which is the whole point of it.
   */
  function run(
    command: string,
    args: readonly string[],
    input: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
      child.stdin.end(input);
    });
  }

  /** Run `git credential fill` for a host, with this runner installed as the helper. */
  function gitCredentialFill(
    host: string,
    env: NodeJS.ProcessEnv = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const helper = `!'${process.execPath}' '${CLI}' git-credential`;
    return run(
      'git',
      ['-c', `credential.https://${host}.helper=${helper}`, 'credential', 'fill'],
      `protocol=https\nhost=${host}\n\n`,
      {
        ...process.env,
        HOME: home,
        // git must not fall through to an interactive prompt when a helper declines: that would hang a
        // headless container forever instead of failing.
        GIT_TERMINAL_PROMPT: '0',
        STEWRA_API_URL: baseUrl,
        STEWRA_API_PREFIX: '',
        ...env,
      },
    );
  }

  it('gives git a freshly minted installation token for github.com', async () => {
    const result = await gitCredentialFill('github.com', {
      STEWRA_RUNNER_DEVICE_TOKEN: DEVICE_TOKEN,
    });

    // git echoes the filled credential back in protocol form — this is what it would send to GitHub.
    expect(result.stdout).toContain('username=x-access-token');
    expect(result.stdout).toContain(`password=${MINTED}`);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('/runner/git-credentials');
    expect(requests[0]?.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
  });

  it('mints again for the next operation instead of reusing the first token', async () => {
    // The security property: access ends when the GitHub App installation says it ends, not an hour
    // later when a cached copy happens to expire.
    await gitCredentialFill('github.com', { STEWRA_RUNNER_DEVICE_TOKEN: DEVICE_TOKEN });
    await gitCredentialFill('github.com', { STEWRA_RUNNER_DEVICE_TOKEN: DEVICE_TOKEN });

    expect(requests).toHaveLength(2);
  });

  it('declines for a host that is not github.com, without asking Stewra for anything', async () => {
    const result = await gitCredentialFill('gitlab.com', {
      STEWRA_RUNNER_DEVICE_TOKEN: DEVICE_TOKEN,
    });

    // A helper declines by exiting 0 with no output; git then has nothing to fill it from.
    expect(result.stdout).not.toContain(MINTED);
    // The real assertion: a GitHub App token was never even requested for a non-GitHub remote.
    expect(requests).toHaveLength(0);
  });

  it('refuses on a machine the user owns, where git has the user\'s own credentials', async () => {
    // No STEWRA_RUNNER_DEVICE_TOKEN means this is a paired laptop, not a hosted container. The laptop
    // invariant is enforced on the backend too; this is the runner declining to even ask.
    const result = await gitCredentialFill('github.com');

    expect(result.stdout).not.toContain(MINTED);
    expect(result.stderr).toContain('only available on a Stewra-hosted runner');
    expect(requests).toHaveLength(0);
  });

  it('fails loudly, and does not fill, when Stewra refuses to mint', async () => {
    respond = (res): void => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Reconnect GitHub to keep running sessions.' }));
    };

    const result = await gitCredentialFill('github.com', {
      STEWRA_RUNNER_DEVICE_TOKEN: DEVICE_TOKEN,
    });

    // The backend's own words reach the developer, rather than a generic git auth failure.
    expect(result.stderr).toContain('Reconnect GitHub');
    expect(result.stdout).not.toContain('password=');
  });

  it('surfaces a rejected device token rather than filling with nothing', async () => {
    const result = await gitCredentialFill('github.com', {
      STEWRA_RUNNER_DEVICE_TOKEN: 'a-revoked-token',
    });

    expect(result.stderr).toContain('not valid');
    expect(result.stdout).not.toContain('password=');
    expect(requests).toHaveLength(1);
  });

  it('treats store and erase as successful no-ops, so git never reports a helper failure', async () => {
    // git runs `store` after a successful authentication. A helper that errored there would make every
    // successful clone print a failure, and there is nothing to store: the token is already expiring.
    for (const operation of ['store', 'erase']) {
      const result = await run(
        process.execPath,
        [CLI, 'git-credential', operation],
        `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${MINTED}\n\n`,
        { ...process.env, HOME: home, STEWRA_RUNNER_DEVICE_TOKEN: DEVICE_TOKEN },
      );
      expect(result.stdout).toBe('');
      expect(result.code).toBe(0);
    }
    expect(requests).toHaveLength(0);
  });
});

describe('git credential protocol parsing', () => {
  it('stops at the blank line that terminates the request', () => {
    // Git may keep the pipe open past the request; anything after the terminator is not part of it.
    const fields = parseCredentialRequest('protocol=https\nhost=github.com\n\nnot=part-of-the-request\n');

    expect(fields.get('host')).toBe('github.com');
    expect(fields.has('not')).toBe(false);
  });

  it('keeps a value that itself contains an equals sign', () => {
    // Passwords do. Splitting on every '=' would hand git a silently truncated credential.
    const fields = parseCredentialRequest('password=abc=def==\n\n');

    expect(fields.get('password')).toBe('abc=def==');
  });

  it('quotes each path so a directory containing a space stays one argument', () => {
    const command = credentialHelperCommand();

    expect(command.startsWith('!')).toBe(true);
    expect(command.endsWith(' git-credential')).toBe(true);
    expect(command).toContain(`'${process.execPath}'`);
  });

  it('formats the reply with the keys git reads', () => {
    expect(formatCredentialAnswer('x-access-token', 'secret')).toBe(
      'username=x-access-token\npassword=secret\n',
    );
  });
});
