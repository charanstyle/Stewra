// @ts-check
/**
 * Root ESLint flat config (ESLint v10 + typescript-eslint v8).
 *
 * Two jobs:
 *  1. Type-import hygiene — `consistent-type-imports` enforces `import type` for
 *     type-only imports. This gives us the `verbatimModuleSyntax` benefit while
 *     the project stays on CommonJS (see tsconfig.base.json).
 *  2. Plane boundary — the agent runtime (untrusted data plane) may not import the
 *     control plane, db, vault, or raw network. Defense-in-depth alongside
 *     .dependency-cruiser.cjs and the containment test.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Don't lint build output, deps, or the hooks' own tooling. `build/` is listed alongside `dist/`
    // because runner/package.json's `clean` removes both — without it, `eslint .` spent all its findings
    // on the generated runner/build/runner.cjs bundle (627 of 690) and buried the real ones.
    // `**/.artifacts/**` is Playwright's output (traces, and the bundled HTML report — which ships
    // its own minified viewer). It is gitignored, but eslint does not read .gitignore, so any run of
    // the e2e suite left `npm run lint` reporting thousands of errors in vendored report assets.
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/.artifacts/**', '.claude/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `.mts`/`.cts` are listed deliberately. typescript-eslint's recommended presets already match them,
    // so they picked up `no-explicit-any`/`prefer-const` — but this block's own rules did not, which
    // exempted every `.mts`/`.cts` file from job 1 above. That silently excused the repo's production
    // CommonJS Electron code (bridge/src/main/ipc.cts) from the one rule this config exists to enforce.
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // Without verbatimModuleSyntax, a `import type` with side effects is a smell.
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // The repo's plain-JS tooling — build scripts, tool configs, e2e helpers — all runs on Node. The
    // `globals.node` above is scoped to the TS block, so without this every `process`/`console`/`__dirname`
    // in those files was reported as `no-undef`: 371 findings that were entirely an artifact of the config.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  },
  {
    // `.cjs` is CommonJS by definition, so `require`/`module`/`exports` are the module system rather than a
    // smell. Scoped to `.cjs` only — `.ts`/`.mts` keep the rule.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // The one catastrophic method: sock.logout() PERMANENTLY UNLINKS the device from the user's
    // WhatsApp account — quitting the app would silently destroy their session on every launch. A test
    // can only prove today's code doesn't call it; this proves no future line in bridge core can.
    // Use sock.end(undefined) — see WhatsappClient.stop().
    files: ['bridge/src/core/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'logout',
          message:
            "logout() PERMANENTLY UNLINKS the device from the user's WhatsApp account. Use sock.end(undefined) — see WhatsappClient.stop().",
        },
      ],
    },
  },
  {
    // Plane boundary: the agent runtime has no direct DB / control-plane / egress access.
    files: ['packages/agent-runtime/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['pg', 'kysely', 'ioredis', 'redis'], message: 'Agent runtime cannot access the database directly — use the injected broker.' },
            { group: ['**/control-plane/**', '**/database/**', '**/vault/**'], message: 'Agent runtime cannot import the control plane — use the injected broker.' },
            { group: ['net', 'http', 'https', 'dns', 'fs', 'node:net', 'node:http', 'node:https', 'node:dns', 'node:fs'], message: 'Agent runtime has no direct network/filesystem egress.' },
          ],
        },
      ],
    },
  },
);
