import { defineConfig } from 'vitest/config';

/**
 * Vitest, not Jest — and only in this workspace. The backend stays on Jest; the root `test` script calls
 * each workspace's own runner, so the two never meet.
 *
 * The reason is Baileys: it is ESM-only from 6.7.19 on, and Jest's runtime is CommonJS. The alternative
 * was freezing Baileys at 6.7.18 to keep Jest quiet, which would have meant shipping a year-stale
 * WhatsApp client to keep a test runner happy. That is backwards, so the test runner moved instead.
 *
 * ⚠️ Vitest resolves CommonJS dependencies through Vite, which is MORE forgiving than Node's own
 * ESM↔CJS interop. A green suite here therefore does NOT prove the Electron main process can import
 * `@stewra/shared-types` (which is still CommonJS). `npm run test:esm-interop` checks that under real
 * Node, and it is part of the workspace's definition of green.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    // No globals: the tests import `describe`/`it`/`expect`/`vi` explicitly, so nothing is ambient and
    // `types` in tsconfig.json stays at just `node`.
    globals: false,
  },
});
