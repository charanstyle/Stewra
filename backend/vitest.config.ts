import { defineConfig } from 'vitest/config';

/**
 * Vitest, not Jest — the backend is ESM now (see tsconfig.json), and Jest's runtime is CommonJS. This
 * matches the bridge workspace; the root `test` script calls each workspace's own runner.
 *
 * `globals: true` keeps the ambient `describe`/`it`/`expect`/`vi` the ported suites already use, so the
 * nine pure-logic files needed no edits and only the three `jest.mock` files became `vi.mock`. The
 * matching `"types": ["vitest/globals", ...]` in tsconfig.json is what makes those ambient at compile time.
 *
 * ⚠️ Vitest resolves CommonJS dependencies through Vite, which is MORE forgiving than Node's own ESM↔CJS
 * interop. A green suite here therefore does NOT prove `node dist/index.js` can import CJS deps (`pg`,
 * `socket.io`, `jsonwebtoken`, …) or the still-CommonJS `@stewra/*` workspaces. Nothing offline does:
 * the check is to actually boot the built backend against the tunnelled DB + Redis, isolated — see the
 * `local-e2e-against-prod-redis` runbook. Verification here is live, not simulated.
 *
 * `fileParallelism: false` carries over the old `jest --runInBand`. Every suite here is currently
 * pure-logic — none opens a database connection — so this is not load-bearing today. It is kept because
 * these tests mutate process-wide state (`globalThis.fetch`, and the mutable config objects the
 * `vi.hoisted` blocks hand to the mock factories), which concurrent files in one process would race on.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/tests/**/*.test.ts'],
    testTimeout: 30000,
    fileParallelism: false,
  },
});
