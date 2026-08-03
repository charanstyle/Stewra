import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The git credential-helper side of hosted mode.
 *
 * Git authenticates by asking a helper program for a username and password, per operation. On a
 * Stewra-hosted runner that helper is this same binary re-invoked: it exchanges the container's device
 * token for a short-lived GitHub App installation token and hands it to git.
 *
 * The alternative — writing a token into the container's `~/.git-credentials` at provision time — would
 * put a long-lived credential on a disk that outlives every session, and would keep working for an hour
 * after the user removed the repository from their GitHub App installation. Minting per operation means
 * access ends when the installation says it ends.
 */

/** The host this runner will answer for. A helper that answered for every host would hand a GitHub App
 *  token to whatever other remote a repository happened to reference. */
export const CREDENTIAL_HOST = 'github.com';

/**
 * How git should re-invoke THIS binary as a credential helper.
 *
 * Derived from the running process rather than assumed, because the runner ships two ways: as
 * `node .../cli.js` (the container image's entrypoint) and as a single packaged executable. A leading `!`
 * tells git the value is a command line to run through the shell rather than a `git-credential-*` name,
 * and git appends the operation (`get`/`store`/`erase`) when it invokes it. Each path is single-quoted so
 * a directory containing a space cannot split into two arguments.
 */
export function credentialHelperCommand(): string {
  const script = process.argv[1];
  const isScriptEntry = script !== undefined && script !== process.execPath && /\.[cm]?js$/.test(script);
  const argv = isScriptEntry ? [process.execPath, script] : [process.execPath];
  return `!${argv.map((part) => `'${part}'`).join(' ')} git-credential`;
}

/**
 * Point git at this binary for github.com, once, into the home volume's `~/.gitconfig`.
 *
 * Re-asserted on every boot rather than checked-then-set. It is a single idempotent write, and the
 * alternative — trusting whatever value is already in the volume — would let a stale command line from an
 * older image silently outlive the upgrade that was supposed to replace it.
 */
export async function configureGitCredentialHelper(): Promise<void> {
  await execFileAsync(
    'git',
    ['config', '--global', `credential.https://${CREDENTIAL_HOST}.helper`, credentialHelperCommand()],
    { timeout: 15_000 },
  );
}

/**
 * Parse git's `key=value` request. Git terminates it with a blank line, and may keep the pipe open after
 * it, so parsing stops there rather than at end-of-input.
 *
 * Values are taken verbatim after the FIRST `=`: a password in a `store` request can contain one, and
 * splitting on every `=` would silently truncate it.
 */
export function parseCredentialRequest(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.trim().length === 0) break;
    const separator = trimmed.indexOf('=');
    if (separator > 0) fields.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return fields;
}

/** Git's expected reply shape for a `get`. */
export function formatCredentialAnswer(username: string, password: string): string {
  return `username=${username}\npassword=${password}\n`;
}
