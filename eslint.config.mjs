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
    // Don't lint build output, deps, or the hooks' own tooling.
    ignores: ['**/dist/**', '**/node_modules/**', '.claude/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
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
