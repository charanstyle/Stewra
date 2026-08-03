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
  resolve: {
    // Load-bearing, not hygiene. This is a workspace root shared with `frontend`, which pins the
    // exact React that Expo SDK 55 requires (19.2.0); the website tracks a newer one (19.2.8). Two
    // different versions cannot be deduped by npm, so the hoisted 19.2.0 stays at the root while the
    // website's own copy sits in its package dir — and any dep whose React resolution walks up to
    // the root (react-hook-form does) gets the OTHER React. `vite dev` hides this because esbuild
    // pre-bundles to one copy; `vite build` shipped both, react-dom installed its dispatcher on one
    // of them, and every hook called through the other read a null dispatcher — a blank login page
    // in production. Forcing one resolution makes the built bundle match what dev serves.
    dedupe: ['react', 'react-dom'],
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
