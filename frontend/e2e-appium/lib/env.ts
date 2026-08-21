// Credentials for the suite, from the repo-root `.env.e2e` shared with the Playwright web suite.
//
// The file is **parsed, not sourced**. It is a dotenv file shared verbatim with the web suite, and
// an unquoted value containing spaces (`E2E_CONTACT_NAME=QA Web B`, which dotenv reads correctly)
// becomes an assignment plus a stray command under shell `source`. Parsing also stops a stray line
// in a secrets file from executing anything.
//
// Real environment variables win over the file, matching the web suite, so CI can inject the same
// names with no file present.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = resolve(HERE, '../../../.env.e2e');

function parseDotenv(contents: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

let fileVars: Map<string, string> | undefined;

function lookup(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;

  if (fileVars === undefined) {
    if (!existsSync(ENV_FILE)) {
      throw new Error(
        `missing shared secrets file at ${ENV_FILE}\n` +
          '       cp .env.e2e.example .env.e2e at the repo root and fill it in.',
      );
    }
    fileVars = parseDotenv(readFileSync(ENV_FILE, 'utf8'));
  }
  const fromFile = fileVars.get(name);
  return fromFile === '' ? undefined : fromFile;
}

/**
 * A required setting. Throws naming the variable and the file when it is missing or blank —
 * nothing here falls back to a default, because a default credential means signing in as the
 * wrong user and reporting a pass.
 */
export function required(name: string): string {
  const value = lookup(name);
  if (value === undefined) {
    throw new Error(`${name} is not set in ${ENV_FILE} (and not in the environment)`);
  }
  return value;
}

/** A genuinely optional setting — absence is a meaningful state, not a missing configuration. */
export function optional(name: string): string | undefined {
  return lookup(name);
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export function userA(): Credentials {
  return { email: required('E2E_USER_A_EMAIL'), password: required('E2E_USER_A_PASSWORD') };
}

export function userB(): Credentials {
  return { email: required('E2E_USER_B_EMAIL'), password: required('E2E_USER_B_PASSWORD') };
}
