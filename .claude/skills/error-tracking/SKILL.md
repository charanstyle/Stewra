---
name: error-tracking
description: Error capture with @sentry/node v10 in Stewra's backend. Use when adding error handling, writing controllers or services, or deciding whether a try/catch belongs at all. The capture points are BaseController.handleError and the Express error boundary; a propagating error is already reported.
---

# Stewra Sentry Integration Skill

## Purpose

Keep every backend failure visible in Sentry **without** wrapping the codebase in redundant
try/catch. `@sentry/node` `^10.69.0`, `backend` only.

## When to Use This Skill

- Adding error handling to any backend code
- Writing controllers, routes, or services
- Deciding whether a `try`/`catch` should exist at all
- Adding context to a failure that is already being captured

## 🚨 The rule

**Errors must reach a capture point.** They already do: `BaseController.handleError` catches at the
controller layer, and `backend/src/middleware/errorHandler.ts` catches everything that propagates
out of a route.

So the rule in practice is the inverse of what it sounds like — **do not swallow.** A `catch` that
returns `[]`, `''`, `null`, or a placeholder instead of re-throwing has removed the failure from
the system, and no amount of Sentry configuration brings it back. `console.error` alone is the
same mistake in a quieter form.

## Sentry Integration Patterns

### 1. Controller error handling — extend BaseController

```typescript
import { BaseController } from './baseController.js';

export class MyController extends BaseController {
    async myMethod(req: Request, res: Response): Promise<void> {
        try {
            const result = await myService.doWork(req.params.id);
            this.handleSuccess(res, result);
        } catch (error) {
            this.handleError(error, res, 'myMethod');   // captures, then renders
        }
    }
}
```

`handleError` takes **three** arguments — `(error, res, context)` — and no status code. The status
comes from the thrown `AppError`; anything unrecognised becomes a 500 with a generic message. To
return a specific status, throw the matching `AppError` subclass.
See [sentry-and-monitoring.md](../backend-dev-guidelines/resources/sentry-and-monitoring.md).

### 2. Routes delegate — they never handle

Every route file looks like `backend/src/routes/activity.ts`:

```typescript
router.get('/', requireAuth, (req, res) => {
  void activityController.list(req, res);
});
```

**The `void` is why rule 1 is not optional.** This is Express **4** (`^4.21.1`), which does not
catch rejected promises from a handler. The returned promise is deliberately discarded, so if the
controller ever let a rejection escape, it would surface as an `unhandledRejection` — not as a 500,
and not through `errorHandler.ts`. `BaseController.handleError` is the thing that makes the `void`
safe.

So: no `try`/`catch` in a route, no `res.status(500)` in a route, and **never** an `async` route
handler that awaits a service directly. Put it in a controller.

`backend/src/middleware/errorHandler.ts` is still the boundary for synchronous throws and for
`next(err)` out of middleware such as `requireAuth`. Note it captures at line 28 only for
**non-`AppError`** — an `AppError` returns at line 24 and is rendered without a Sentry event,
because a 404 from `requireAuth` is a normal outcome, not an incident.

`BaseController.handleError` is different: it captures *unconditionally*, before its own `AppError`
check. So the same `NotFoundError` produces an event when it comes from a controller and no event
when it comes from middleware. Worth knowing before you read anything into Sentry's counts.

> There is no `asyncErrorWrapper` and no `errorBoundary` module in this repo. If you want the
> Express-5 "just throw" ergonomics, that is an upgrade to propose, not a pattern to assume.

### 3. Service layer — only when you add context

```typescript
try {
    await someOperation();
} catch (error) {
    Sentry.captureException(error, {
        tags: { service: 'gmailSync', operation: 'someOperation' },
        extra: { userId, connectionId },
    });
    throw error;   // ← not optional
}
```

18 modules under `backend/src/services` and `backend/src/websocket` do this. The re-throw is the
whole discipline: a catch that captures and then returns a value has converted a failure into a
fabricated result, and Sentry becomes the only place the failure exists at all.

If the catch adds no tag, no extra, and no recovery, delete it — the boundary already captures.

### 4. Scheduled work

Recurring work lives in `backend/src/scheduler/scheduler.ts` as plain `setInterval`. There are no
standalone cron scripts, so there is no second `import '../instrument'` to place —
`backend/src/index.ts` already did it as its first import.

Inside an interval callback, **catching without re-throwing is correct**:

```typescript
setInterval(() => {
  void tick().catch((error) => {
    Sentry.captureException(error);   // no caller to propagate to;
  });                                 // an uncaught throw here kills the process
}, intervalMs);
```

This is the one exception to rule 3. A failed tick should be reported and the next tick should
still run.

> ### ⚠️ Not in this repo
>
> `WorkflowSentryHelper`, `EmailSentryHelper`, `SentryHelper`, `DatabasePerformanceMonitor`,
> `utils/databasePerformance.ts`, `sentry.ini`, and `@sentry/profiling-node` do **not** exist here,
> and `Sentry.startSpan` appears zero times in `backend/src`. Earlier revisions of this skill
> documented all of them. If you need custom spans or query timing, you are adding a capability,
> not following a pattern — say so in the PR.

## Error Levels

Use appropriate severity levels:

- **fatal**: System is unusable (database down, critical service failure)
- **error**: Operation failed, needs immediate attention
- **warning**: Recoverable issues, degraded performance
- **info**: Informational messages, successful operations
- **debug**: Detailed debugging information (dev only)

## Adding context

`environment` and the DSN are already set globally by `instrument.ts`; do not re-tag them per
capture. Add only what the capture point does not already know:

```typescript
import * as Sentry from '@sentry/node';

Sentry.withScope((scope) => {
    scope.setUser({ id: userId });
    scope.setTag('service', 'gmailSync');
    scope.setContext('operation', { type: 'sync.incremental', connectionId, historyId });
    Sentry.captureException(error);
});
```

Never put a token, a password, a raw email body, or a full row into `extra`. The DSN may point at
a self-hosted GlitchTip, but it is still off-box.

## Configuration

One optional variable, read through `unifiedConfig` — never `process.env` directly:

| Variable | Where | Effect |
|----------|-------|--------|
| `SENTRY_DSN` | `unifiedConfig.ts:52` → `config.sentry.dsn` (`:580`) | Unset ⇒ `Sentry.init()` never runs and all captures are no-ops |

`tracesSampleRate` is not configurable; `instrument.ts` derives it as
`config.isProduction ? 0.1 : 1.0`.

There is no `config.ini` and no `[databaseMonitoring]` section — those belong to a different
codebase. See [configuration.md](../backend-dev-guidelines/resources/configuration.md).

## Verifying it works

There are **no `/sentry/test-*` endpoints**. To confirm capture end to end:

1. Set `SENTRY_DSN` in `backend/.env` — without it `Sentry.init()` never runs and there is nothing
   to see.
2. Start the backend and hit any route that throws (an unknown id against a route whose service
   throws `NotFoundError` is enough).
3. Confirm the event in the Sentry/GlitchTip project.

If nothing arrives, check the DSN before suspecting the code. A no-op capture and a working capture
look identical from inside the process.

The suites do **not** set a DSN, so a green test run says nothing about whether capture works.

## Performance Monitoring

> ### ⚠️ Not adopted
>
> Tracing is whatever `tracesSampleRate` collects automatically. `Sentry.startSpan` appears zero
> times in `backend/src`; there is no query timing, no slow-query threshold, and no N+1 detection.
>
> Note also that `Sentry.Handlers.requestHandler()` and `Sentry.startTransaction()` — which earlier
> revisions of this skill recommended — were **removed in Sentry v8** and do not exist in the v10
> SDK this repo uses. Do not reach for them.

## Common Mistakes to Avoid

❌ **NEVER** swallow an error — a `catch` that returns a value in place of a failure is the worst
   one on this list, because it removes the failure rather than hiding it
❌ **NEVER** capture and then *not* re-throw, outside a `setInterval` callback
❌ **NEVER** add a try/catch that contributes no tag, no context, and no recovery — the boundary
   already captures it, and the wrapper only makes the code look handled
❌ **NEVER** use `console.error` in place of letting the error propagate
❌ **NEVER** put tokens, passwords, message bodies, or whole rows in `extra`
❌ **NEVER** pass a status code to `handleError` — throw the matching `AppError` instead

## Implementation Checklist

- [ ] Does this `try`/`catch` need to exist? If it adds nothing, delete it
- [ ] If it exists: does it re-throw (or is it a `setInterval` body)?
- [ ] Errors thrown are `AppError` subclasses, so the status code is theirs
- [ ] Context added is context the capture point does not already have
- [ ] No secrets or raw payloads in `tags`/`extra`
- [ ] The failure path was actually exercised, not just written

## Key Files

The Sentry surface in this repo is small. It is all in `backend/`, and it is all of it:

| File | Role |
|------|------|
| `backend/src/instrument.ts` | `Sentry.init()`. 12 lines. |
| `backend/src/index.ts:2` | `import './instrument.js'` — the **first** import, before anything else loads |
| `backend/src/config/unifiedConfig.ts:52,580` | `SENTRY_DSN` (optional) → `config.sentry.dsn` |
| `backend/src/controllers/baseController.ts` | `handleError()` — the controller-layer capture point |
| `backend/src/middleware/errorHandler.ts` | the Express error boundary — captures **non-`AppError`** only (`:28`) |

`@sentry/node` `^10.69.0` is a dependency of `backend` only. There is no `sentry.ini`, no
`SentryHelper`, no `EmailSentryHelper`, and no `DatabasePerformanceMonitor` — if you find those
named in a guide, the guide is describing a different codebase.

### The DSN is optional, and that is deliberate

```typescript
if (config.sentry.dsn) {
  Sentry.init({ /* ... */ });
}
```

With `SENTRY_DSN` unset, `Sentry.init()` is never called and every `captureException` is a no-op.
That is why local runs and the test suites need no DSN. It is also why "I did not see it in Sentry"
is not evidence an error did not happen — check whether the DSN was set for that environment first.

Note this is **not** a config default in the banned sense: `SENTRY_DSN` names a *behaviour* (report
errors upstream, or don't), not a *target the code acts on*. Contrast `DATABASE_URL`, which has no
default and must fail loudly — see [configuration.md](../backend-dev-guidelines/resources/configuration.md).

## Related Skills

- **backend-dev-guidelines** — the layered architecture these capture points sit in; its
  [sentry-and-monitoring.md](../backend-dev-guidelines/resources/sentry-and-monitoring.md) covers
  the same ground in more depth
- **api-contract-validation** — keeping the error response shape in `@stewra/shared-types`
