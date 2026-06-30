/**
 * Boundary enforcement for the agent runtime (the untrusted data plane).
 * The agent must NEVER reach credentials, the database, or the network directly.
 * It may only depend on @stewra/shared-types and obtain data through an injected broker.
 */
module.exports = {
  forbidden: [
    {
      name: 'agent-no-control-plane',
      comment: 'agent-runtime must not import control-plane internals, db, or vault',
      severity: 'error',
      from: { path: '^packages/agent-runtime/src' },
      to: { path: '(control-plane|database|vault|broker/broker)' },
    },
    {
      name: 'agent-no-db-drivers',
      comment: 'agent-runtime must not import db drivers / query builders',
      severity: 'error',
      from: { path: '^packages/agent-runtime/src' },
      to: { path: 'node_modules/(pg|kysely|ioredis|redis)' },
    },
    {
      name: 'agent-no-raw-network-fs',
      comment: 'agent-runtime must not import raw network or filesystem modules',
      severity: 'error',
      from: { path: '^packages/agent-runtime/src' },
      to: { path: '^(net|http|https|dns|fs|node:net|node:http|node:https|node:dns|node:fs)$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // No tsConfig here on purpose: agent-runtime imports only the real package
    // `@stewra/shared-types` and node builtins (no TS path aliases), so depcruise's own module
    // resolution is sufficient — and pointing at agent-runtime/tsconfig.json makes depcruise
    // mis-resolve its `extends: "../../tsconfig.base.json"` and crash. The forbidden rules below
    // match resolved paths directly, so the import boundary is still fully enforced.
  },
};
