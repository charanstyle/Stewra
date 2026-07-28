import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

/**
 * Load `backend/.env.test` before any suite imports `unifiedConfig`.
 *
 * The suites here are not simulated: they open a real Postgres connection and a real Redis
 * connection, because a repository test that asserts a stub was called proves the call site and
 * nothing about the SQL. That means the config schema has to parse for real, which means the env has
 * to be real — so this runs as a Vitest `setupFiles` entry, which executes before the test module is
 * evaluated.
 *
 * `dotenv` never overwrites a variable that is already set, which is what makes a suite able to pin
 * a feature flag (`process.env.WHATSAPP_PERSONAL_ENABLED = 'true'`) before importing the config and
 * still inherit the shared DATABASE_URL from this file.
 *
 * Missing file = hard failure, deliberately. Skipping the DB-backed suites when credentials are
 * absent would turn "I have no test database" into a green run, which is the exact failure mode
 * these tests exist to rule out.
 */
const ENV_FILE = resolve(process.cwd(), '.env.test');

if (!existsSync(ENV_FILE)) {
  throw new Error(
    `The backend test suite needs ${ENV_FILE}, which does not exist.\n` +
      'Copy backend/.env.test.example to backend/.env.test and fill it in — the header of that ' +
      'file has the one-time Postgres setup and the `npm run tunnel` command the suite depends on.',
  );
}

const result = loadEnv({ path: ENV_FILE });
if (result.error !== undefined) {
  throw result.error;
}
