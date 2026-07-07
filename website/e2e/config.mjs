// E2E configuration loader.
//
// Never hardcodes URLs or tokens: values come from environment variables (preferred,
// CI-friendly) or an untracked `e2e.config.json` (gitignored — for local runs). Env wins.
// Required values are validated up front and throw loudly if absent, so a run can never
// silently target the wrong host or auth as the wrong user.
//
// See `e2e.config.example.json` for the file shape and `README.md` for the env-var names.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function fromFile() {
  const p = join(HERE, 'e2e.config.json');
  if (!existsSync(p)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`[e2e] e2e.config.json is present but not valid JSON: ${err.message}`);
  }
}

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `[e2e] Missing required config "${name}". Provide it via an environment variable ` +
        `or e2e.config.json (copy e2e.config.example.json). See README.md.`,
    );
  }
  return value;
}

const file = fromFile();
const env = process.env;
const users = file.users || {};
const fileA = users.a || {};
const fileB = users.b || {};

const webUrl = required(env.E2E_WEB_URL || file.webUrl, 'webUrl (env E2E_WEB_URL)').replace(/\/$/, '');

export const config = {
  webUrl,
  // API is same-origin under /api by default (nginx strips the prefix in production).
  apiUrl: (env.E2E_API_URL || file.apiUrl || `${webUrl}/api`).replace(/\/$/, ''),
  // Optional 16 kHz mono WAV fed to WebRTC as fake mic input so speech-to-text produces a real transcript.
  audioFile: env.E2E_AUDIO_FILE || file.audioFile || '',
  users: {
    a: {
      email: env.E2E_USER_A_EMAIL || fileA.email || '',
      accessToken: required(env.E2E_USER_A_ACCESS || fileA.accessToken, 'users.a.accessToken (env E2E_USER_A_ACCESS)'),
      refreshToken: required(env.E2E_USER_A_REFRESH || fileA.refreshToken, 'users.a.refreshToken (env E2E_USER_A_REFRESH)'),
    },
    b: {
      email: env.E2E_USER_B_EMAIL || fileB.email || '',
      accessToken: required(env.E2E_USER_B_ACCESS || fileB.accessToken, 'users.b.accessToken (env E2E_USER_B_ACCESS)'),
      refreshToken: required(env.E2E_USER_B_REFRESH || fileB.refreshToken, 'users.b.refreshToken (env E2E_USER_B_REFRESH)'),
    },
  },
};
