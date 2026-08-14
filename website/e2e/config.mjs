// E2E configuration loader.
//
// Never hardcodes URLs or credentials: values come from environment variables (preferred,
// CI-friendly) or the single `.env.e2e` at the repo root (gitignored — only the template is
// tracked; QA credentials only — production secrets go in env vars; shared
// with the Maestro mobile suite). Real env vars win over the file. Required values are
// validated up front and throw loudly if absent, so a run can never silently target the
// wrong host or authenticate as the wrong user.
//
// See `../../.env.e2e.example` for the file shape and `README.md` for the env-var names.
// The loader itself lives in `env.mjs`, shared with the credential-free smoke config.
import { env, required } from './env.mjs';

const webUrl = required(env.E2E_WEB_URL, 'E2E_WEB_URL').replace(/\/$/, '');

// Either the sign-up feature is off, or it is fully specified — never partly guessed. An ssh
// host and a container name have no sane default: guessing one turns a missing setting into a
// run that quietly targets the wrong machine and reports the absent code as a product failure.
function signupConfig() {
  const mailbox = env.E2E_SIGNUP_MAILBOX;
  if (!mailbox) {
    return { enabled: false };
  }
  return {
    enabled: true,
    mailbox,
    sshHost: required(env.E2E_SIGNUP_SSH_HOST, 'E2E_SIGNUP_SSH_HOST'),
    imapContainer: required(env.E2E_SIGNUP_IMAP_CONTAINER, 'E2E_SIGNUP_IMAP_CONTAINER'),
  };
}

export const config = {
  webUrl,
  // API is same-origin under /api by default (nginx strips the prefix in production).
  apiUrl: (env.E2E_API_URL || `${webUrl}/api`).replace(/\/$/, ''),
  // Optional 16 kHz mono WAV fed to WebRTC as fake mic input so speech-to-text produces a real transcript.
  audioFile: env.E2E_AUDIO_FILE || '',
  // OPTIONAL direct DB connection, used ONLY to provision the destructive-but-reversible lifecycle
  // tests (today nudge actions, memory delete) — see seed.mjs. Empty by default: without it those
  // tests skip rather than run, so the minimal "just emails+passwords" contract still holds.
  databaseUrl: env.E2E_DATABASE_URL || '',
  // Mobile-only, surfaced here so both suites read one file. Optional for the web suite.
  contactName: env.E2E_CONTACT_NAME || '',
  // OPTIONAL real mailbox for reading emailed verification codes — what lets the sign-up flow
  // be driven through the UI instead of stubbed. Off unless E2E_SIGNUP_MAILBOX is set, because
  // every run leaves a NEW permanent account behind: `audit_log` references `users` with
  // ON DELETE SET NULL and the append-only trigger rejects that UPDATE, so users that sign up
  // cannot be deleted. Once it IS set the rest are required, not defaulted: an ssh host and a
  // container name are infrastructure this file must never guess.
  signup: signupConfig(),
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
