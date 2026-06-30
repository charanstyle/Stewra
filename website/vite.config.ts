import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server port doubles as the app's public origin (WEB_APP_URL on the backend), which the
// backend uses for the CORS origin and the post-OAuth redirect. Keep them in sync.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  // @stewra/shared-types is a linked workspace package emitting CommonJS, and it resolves to its
  // source dir outside node_modules. Rollup's commonjs plugin only transforms node_modules by
  // default, so without this it can't see the package's runtime named exports (the lookback bound
  // constants). Include the package dir so its CJS named exports are surfaced for ESM consumers.
  build: {
    commonjsOptions: {
      include: [/shared-types/, /node_modules/],
    },
  },
  optimizeDeps: {
    include: ['@stewra/shared-types'],
  },
});
