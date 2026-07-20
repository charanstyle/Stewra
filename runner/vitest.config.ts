import { defineConfig } from 'vitest/config';

/**
 * Vitest (matching the bridge workspace), not the backend's Jest. The runner is ESM on `nodenext`, so its
 * tests run under Vite's resolver.
 *
 * ⚠️ Same caveat as the bridge: Vitest's CJS↔ESM interop is more forgiving than Node's own. A green suite
 * here does not prove the real Node runtime can import `@stewra/shared-types` (CommonJS) — `npm run
 * test:esm-interop` checks that under actual Node, and it is part of this workspace's definition of green.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    globals: false,
  },
});
