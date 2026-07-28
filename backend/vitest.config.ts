import { defineConfig } from 'vitest/config';

/**
 * Vitest, not Jest — the backend is ESM now (see tsconfig.json), and Jest's runtime is CommonJS. This
 * matches the bridge workspace; the root `test` script calls each workspace's own runner.
 *
 * `globals: true` keeps the ambient `describe`/`it`/`expect`/`vi` the suites already use, and the
 * matching `"types": ["vitest/globals", ...]` in tsconfig.json is what makes those ambient at compile
 * time.
 *
 * THESE TESTS ARE NOT SIMULATED. The suites that touch storage open a real Postgres connection and a
 * real Redis connection — the `stewra_test` database and Redis db 15 exist for exactly that, reached
 * over the SSH tunnels `npm run tunnel` brings up. That is a deliberate cost: a repository test built
 * on a stubbed `db` asserts only that a call was made, and says nothing about whether the SQL is
 * valid, the column exists, or the transaction really rolls back. `setupFiles` loads `.env.test`
 * before any suite imports `unifiedConfig`, and fails loudly when it is missing rather than skipping
 * — see `backend/.env.test.example` for the one-time setup.
 *
 * ⚠️ Still NOT covered here: Vitest resolves CommonJS dependencies through Vite, which is MORE
 * forgiving than Node's own ESM↔CJS interop. A green suite therefore does not prove `node
 * dist/index.js` can import CJS deps (`pg`, `socket.io`, `jsonwebtoken`, …) or the still-CommonJS
 * `@stewra/*` workspaces. The check for that is to boot the BUILT backend (`npm run build`, then
 * `npm start -w backend`) against the same tunnelled Postgres and Redis and watch it come up.
 *
 * `fileParallelism: false` carries over the old `jest --runInBand`, and is now load-bearing: every
 * suite shares the one `stewra_test` database, and the DB-backed ones pin `process.env` before a
 * dynamic `import()` of the config, which concurrent files in a single process would race on.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/tests/**/*.test.ts'],
    setupFiles: ['./src/tests/setupEnv.ts'],
    testTimeout: 30000,
    fileParallelism: false,
  },
});
