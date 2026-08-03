// Shared env loader for both Playwright configs in this package.
//
// It lives apart from `config.mjs` because `config.mjs` validates the QA credentials at module
// load — importing it is enough to throw without a `.env.e2e`. The post-deploy smoke gate must run
// with no credentials at all (that is the point of it: anyone can gate a deploy on it), so it needs
// the loader without the credential contract. Same file, same precedence rules, one source of truth.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Parse the shared repo-root .env.e2e (KEY=VALUE lines). Does NOT overwrite real env vars.
/** @returns {Record<string, string | undefined>} */
export function fromEnvFile() {
  const p = join(HERE, '..', '..', '.env.e2e');
  if (!existsSync(p)) {
    return {};
  }
  const out = {};
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {string | undefined} value
 * @param {string} name
 * @returns {string}
 */
export function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `[e2e] Missing required config "${name}". Set it in the repo-root .env.e2e ` +
        `(copy .env.e2e.example) or as an environment variable. See README.md.`,
    );
  }
  return value;
}

// Env wins over the file so CI can inject the same names.
/** @type {Record<string, string | undefined>} */
export const env = { ...fromEnvFile(), ...process.env };
