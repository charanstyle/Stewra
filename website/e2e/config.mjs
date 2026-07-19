// E2E configuration loader.
//
// Never hardcodes URLs or credentials: values come from environment variables (preferred,
// CI-friendly) or the single untracked `.env.e2e` at the repo root (gitignored — shared
// with the Maestro mobile suite). Real env vars win over the file. Required values are
// validated up front and throw loudly if absent, so a run can never silently target the
// wrong host or authenticate as the wrong user.
//
// See `../../.env.e2e.example` for the file shape and `README.md` for the env-var names.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Parse the shared repo-root .env.e2e (KEY=VALUE lines). Does NOT overwrite real env vars.
function fromEnvFile() {
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

const file = fromEnvFile();
// Env wins over the file so CI can inject the same names.
const env = { ...file, ...process.env };

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `[e2e] Missing required config "${name}". Set it in the repo-root .env.e2e ` +
        `(copy .env.e2e.example) or as an environment variable. See README.md.`,
    );
  }
  return value;
}

const webUrl = required(env.E2E_WEB_URL, 'E2E_WEB_URL').replace(/\/$/, '');

export const config = {
  webUrl,
  // API is same-origin under /api by default (nginx strips the prefix in production).
  apiUrl: (env.E2E_API_URL || `${webUrl}/api`).replace(/\/$/, ''),
  // Optional 16 kHz mono WAV fed to WebRTC as fake mic input so speech-to-text produces a real transcript.
  audioFile: env.E2E_AUDIO_FILE || '',
  // Mobile-only, surfaced here so both suites read one file. Optional for the web suite.
  contactName: env.E2E_CONTACT_NAME || '',
  users: {
    a: {
      email: required(env.E2E_USER_A_EMAIL, 'E2E_USER_A_EMAIL'),
      password: required(env.E2E_USER_A_PASSWORD, 'E2E_USER_A_PASSWORD'),
      // Populated at runtime by loginAll() in lib.mjs.
      accessToken: '',
      refreshToken: '',
    },
    b: {
      email: required(env.E2E_USER_B_EMAIL, 'E2E_USER_B_EMAIL'),
      password: required(env.E2E_USER_B_PASSWORD, 'E2E_USER_B_PASSWORD'),
      accessToken: '',
      refreshToken: '',
    },
  },
};
