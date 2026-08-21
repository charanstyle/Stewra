/**
 * Boundary enforcement for two separations that are load-bearing:
 *
 *  1. The agent runtime (the untrusted data plane) must NEVER reach credentials, the database, or
 *     the network directly. It may only depend on @stewra/shared-types and obtain data through an
 *     injected broker.
 *  2. The commerce plane (`backend/src/commerce`, scoped by `org_id`) and the personal-assistant
 *     plane (scoped by `user_id`) must not import each other's repositories or services. They share
 *     infrastructure — config, database handle, errors, auth middleware, the vault — and nothing
 *     else. A commerce query that reaches a `user_id`-scoped repository is a tenancy bug, and the
 *     cheapest place to catch it is at the import.
 *  3. `backend/src/tenancy` — organizations, membership and `requireOrgMember` — is neither plane.
 *     Every account is a tenant, so both planes scope by the same org id and both must be able to
 *     import it. That only stays true while tenancy itself depends on nothing but infrastructure:
 *     the moment it reaches into either plane's repositories it stops being a primitive and becomes
 *     a cycle, and whichever plane it reached into can no longer be dropped from the build.
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
    {
      name: 'commerce-no-personal-assistant',
      comment:
        'the commerce plane must not import personal-assistant repositories or services — those are ' +
        'scoped by user_id, and reaching one from an org-scoped path is how a tenant boundary leaks',
      severity: 'error',
      from: { path: '^backend/src/commerce/' },
      to: { path: '^backend/src/(repositories|services)/' },
    },
    {
      name: 'personal-assistant-no-commerce',
      comment:
        'nothing outside the commerce context may import it. The composition root is exempt, and it ' +
        'is two files: app.ts mounts the routes, index.ts owns the process lifecycle and starts the ' +
        'background work. The tests reach in on purpose. Everything else — repositories, services, ' +
        'the personal-assistant scheduler — stays out',
      severity: 'error',
      from: {
        path: '^backend/src/',
        pathNot: '^backend/src/(commerce/|app\\.ts$|index\\.ts$|tests/)',
      },
      to: { path: '^backend/src/commerce/' },
    },
    {
      name: 'tenancy-is-a-primitive',
      comment:
        'tenancy is what both planes agree on, so it must depend on neither. It may reach the ' +
        'database handle, config, errors, validation, the base controller, auth middleware and ' +
        'ports/ — infrastructure both planes already share. A repository or service from either ' +
        'plane makes it that plane\'s dependent, and the import graph stops having a bottom',
      severity: 'error',
      from: { path: '^backend/src/tenancy/' },
      to: { path: '^backend/src/(repositories|services|commerce)/' },
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
