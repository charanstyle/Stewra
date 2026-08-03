import { defineConfig } from 'vitest/config';

/**
 * The provisioner suite runs against a REAL Docker Engine — it creates, starts, stops, and destroys
 * actual containers and volumes, because a provisioner test against a stubbed Docker asserts only
 * that a request was shaped, and says nothing about whether the daemon accepts the template. When no
 * Docker socket exists on this machine the suite announces the skip LOUDLY with instructions (see
 * TESTING.md); when DOCKER_SOCKET is set explicitly and unreachable, it fails — never a silent green.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/tests/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
