# Sentry Integration and Monitoring

Error tracking with `@sentry/node` `^10.69.0`, a dependency of `backend` and nothing else.

> **Read the first two sections before the rest.** Everything from *Performance Monitoring* onward
> describes patterns this repo has **not** adopted. They are kept as a reference for what to write
> if you add one — not as a description of what is there. Each such section says so in a banner.
> The `error-tracking` skill's Key Files table is the short, complete inventory.

## Table of Contents

- [Core Principles](#core-principles)
- [Sentry Initialization](#sentry-initialization)
- [Error Capture Patterns](#error-capture-patterns)
- [Performance Monitoring](#performance-monitoring)
- [Cron Job Monitoring](#cron-job-monitoring)
- [Error Context Best Practices](#error-context-best-practices)
- [Common Mistakes](#common-mistakes)

---

## Core Principles

Errors that reach a controller or the Express error boundary are captured to Sentry. Both capture
points already do it for you — see below. What you must not do is *swallow* an error so that
neither point ever sees it.

---

## Sentry Initialization

### What is actually here

`backend/src/instrument.ts`, in full:

```typescript
// Sentry/GlitchTip instrumentation. MUST be imported first (see index.ts) so it can
// instrument everything that loads afterward. No-op when SENTRY_DSN is unset (M0 default).
import * as Sentry from '@sentry/node';
import { config } from './config/unifiedConfig.js';

if (config.sentry.dsn) {
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.nodeEnv,
    tracesSampleRate: config.isProduction ? 0.1 : 1.0,
  });
}
```

`backend/src/index.ts:2` imports it **first**, before any other module:

```typescript
// Sentry must be the FIRST import so it instruments everything loaded afterwards.
import './instrument.js';
```

Two things to hold onto:

- **The DSN comes from `unifiedConfig`, not `process.env`, and not a file.** There is no
  `sentry.ini`. Adding one would reintroduce the config pattern
  [configuration.md](configuration.md) documents as retired.
- **With `SENTRY_DSN` unset, `init` never runs and every `captureException` is a silent no-op.**
  That is intended — it is why the test suites and local runs need no DSN. It also means "nothing
  in Sentry" proves nothing unless you first confirm the DSN was set for that environment.

### ⚠️ Reference only — the expanded init below is NOT in this repo

The template that follows shows what a fuller `Sentry.init` looks like. **Nothing in this repo uses
it.** If you adopt any of it, source every value from `unifiedConfig` — the
`process.env.X || 'default'` shape it originally carried is denied by `fallback-guard.py`.

```typescript
Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.nodeEnv,
    tracesSampleRate: config.isProduction ? 0.1 : 1.0,

    integrations: [
        ...Sentry.getDefaultIntegrations({}),
        Sentry.extraErrorDataIntegration({ depth: 5 }),
        Sentry.localVariablesIntegration(),
        Sentry.requestDataIntegration({
            include: {
                cookies: false,
                data: true,
                headers: true,
                ip: true,
                query_string: true,
                url: true,
                user: { id: true, email: true, username: true },
            },
        }),
        Sentry.consoleIntegration(),
        Sentry.contextLinesIntegration(),
        Sentry.postgresIntegration(),   // `pg` — this repo has no Prisma
    ],

    beforeSend(event, hint) {
        // Filter health checks
        if (event.request?.url?.includes('/healthcheck')) {
            return null;
        }

        // Scrub sensitive headers
        if (event.request?.headers) {
            delete event.request.headers['authorization'];
            delete event.request.headers['cookie'];
        }

        // Mask emails for PII
        if (event.user?.email) {
            event.user.email = event.user.email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
        }

        return event;
    },

    ignoreErrors: [
        /^Invalid JWT/,
        /^JWT expired/,
        'NetworkError',
    ],
});

// Set service context
Sentry.setTags({
    service: 'form',
    version: '1.0.1',
});

Sentry.setContext('runtime', {
    node_version: process.version,
    platform: process.platform,
});
```

**Critical Points:**
- PII protection built-in (beforeSend)
- Filter non-critical errors
- Comprehensive integrations
- Postgres (`pg`) instrumentation
- Service-specific tagging

---

## Error Capture Patterns

### 1. BaseController — the real one

`backend/src/controllers/baseController.ts`. You do not write capture code in a controller; you
call `this.handleError(error, res, context)` and it is captured for you:

```typescript
protected handleError(error: unknown, res: Response, context: string): void {
    Sentry.captureException(error);

    if (error instanceof AppError) {
      const details =
        error instanceof ValidationError
          ? error.details.map((d) => ({ field: d.field, message: d.message }))
          : [];
      const body: ApiResponse<never> = {
        success: false,
        error: { code: error.code, message: error.message, details },
      };
      res.status(error.statusCode).json(body);
      return;
    }

    logger.error('Unhandled error in controller', {
      context,
      error: error instanceof Error ? error.message : String(error),
    });
    const body: ApiResponse<never> = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', details: [] },
    };
    res.status(500).json(body);
}
```

What this buys, and what it constrains:

- **The status code is the error's, not the caller's.** There is no `statusCode` parameter. An
  `AppError` subclass carries its own `statusCode` and `code`; anything else is a 500. To return a
  409, throw a `ConflictError` — do not pass a number.
- **Unrecognised errors never leak their message to the client.** They become a flat
  `'Something went wrong'`, with the real message going to `logger.error` and the full object to
  Sentry. That is deliberate: an unexpected error's message can contain a query, a path, or a token.
- **The response shape is `ApiResponse<T>` from `@stewra/shared-types`,** so the client's error
  handling is type-checked against the same definition.

### 2. The Express error boundary

`backend/src/middleware/errorHandler.ts:28` is the second capture point. It handles synchronous
throws and `next(err)` out of middleware such as `requireAuth`.

**It is not a safety net for async controller work.** This is Express `^4.21.1`, and routes are
written as `void controller.method(req, res)` — the promise is deliberately discarded, so a
rejection escaping a controller becomes an `unhandledRejection`, not a 500. `handleError` is what
makes that shape safe, which is why rule 1 is not optional.

Between the two, **an error thrown inside a service and allowed to propagate up to its controller
is already reported** — that is the argument for letting it propagate rather than wrapping it.

> ⚠️ There is no `SentryHelper` / `captureOperationError` in this repo. If a guide or an older
> comment references one, it is describing a different codebase.

### 3. Service layer — capture only where you add context

Around twenty service and websocket modules call `Sentry.captureException` directly. They do it
where the *catch adds information the capture point above would not have*, and they re-throw:

```typescript
try {
    await someOperation();
} catch (error) {
    Sentry.captureException(error, {
        tags: { service: 'gmailSync', operation: 'someOperation' },
        extra: { userId: currentUser.id, connectionId },
    });
    throw error;   // ← the re-throw is not optional
}
```

The re-throw is what keeps this honest. A catch that captures and then returns a value converts a
failure into a fabricated result — the caller cannot distinguish it from success, and Sentry
becomes the only place the failure exists. See
[async-and-errors.md](async-and-errors.md).

Do **not** add this wrapper by reflex. If the catch adds no tag, no context, and no recovery, it is
pure noise: delete it and let the error reach the controller's `handleError`, which captures it
anyway.

---

## Performance Monitoring

> ### ⚠️ Reference only — none of this section is in this repo
>
> `Sentry.startSpan` appears **zero** times in `backend/src`, and there is no
> `DatabasePerformanceMonitor` or `utils/databasePerformance.ts`. Tracing is limited to what
> `tracesSampleRate` collects automatically. Treat what follows as a sketch to work from if you add
> tracing — not as a pattern to match.

### Database Performance Tracking

```typescript
import { DatabasePerformanceMonitor } from '../utils/databasePerformance';   // ← does not exist

const result = await DatabasePerformanceMonitor.withPerformanceTracking(
    'findMany',
    'UserProfile',
    async () => {
        return await db.selectFrom('user_profiles').selectAll().limit(5).execute();
    }
);
```

### API Endpoint Spans

```typescript
router.post('/operation', async (req, res) => {
    return await Sentry.startSpan({
        name: 'operation.execute',
        op: 'http.server',
        attributes: {
            'http.method': 'POST',
            'http.route': '/operation'
        }
    }, async () => {
        const result = await performOperation();
        res.json(result);
    });
});
```

---

## Scheduled Work

### What is actually here

There are **no standalone cron scripts**. Recurring work runs in-process in
`backend/src/scheduler/scheduler.ts` — plain `setInterval`, dependency-free, and off unless config
enables it. It needs no `import '../instrument'` of its own, because it is loaded by
`backend/src/index.ts`, which already imported it first.

Every one of its interval bodies wraps its work in a `try`/`catch` that calls
`Sentry.captureException` (lines 65, 74, 90, 111, 130). That is the one place where **catching
without re-throwing is correct**: there is no caller to propagate to, and an uncaught throw inside
a `setInterval` callback takes down the process. A tick that fails should be reported and the next
tick should still run.

> ### ⚠️ Reference only — the standalone-cron pattern below is not used here
>
> Kept for the case where a job genuinely needs its own process. If you add one, the
> first-import rule is real and applies.

```typescript
#!/usr/bin/env node
import '../instrument'; // FIRST LINE after shebang
import * as Sentry from '@sentry/node';

async function main() {
    return await Sentry.startSpan({
        name: 'cron.job-name',
        op: 'cron',
        attributes: {
            'cron.job': 'job-name',
            'cron.startTime': new Date().toISOString(),
        }
    }, async () => {
        try {
            // Cron job logic here
        } catch (error) {
            Sentry.captureException(error, {
                tags: {
                    'cron.job': 'job-name',
                    'error.type': 'execution_error'
                }
            });
            console.error('[Cron] Error:', error);
            process.exit(1);
        }
    });
}

main().then(() => {
    console.log('[Cron] Completed successfully');
    process.exit(0);
}).catch((error) => {
    console.error('[Cron] Fatal error:', error);
    process.exit(1);
});
```

---

## Error Context Best Practices

### Rich Context Example

```typescript
Sentry.withScope((scope) => {
    // User context
    scope.setUser({
        id: user.id,
        email: user.email,
        username: user.username
    });

    // Tags for filtering
    scope.setTag('service', 'form');
    scope.setTag('endpoint', req.path);
    scope.setTag('method', req.method);

    // Structured context
    scope.setContext('operation', {
        type: 'workflow.complete',
        workflowId: 123,
        stepId: 456
    });

    // Breadcrumbs for timeline
    scope.addBreadcrumb({
        category: 'workflow',
        message: 'Starting step completion',
        level: 'info',
        data: { stepId: 456 }
    });

    Sentry.captureException(error);
});
```

---

## Common Mistakes

```typescript
// ❌ Swallowing errors
try {
    await riskyOperation();
} catch (error) {
    // Silent failure
}

// ❌ Generic error messages
throw new Error('Error occurred');

// ❌ Exposing sensitive data
Sentry.captureException(error, {
    extra: { password: user.password } // NEVER
});

// ❌ Missing async error handling
async function bad() {
    fetchData().then(data => processResult(data)); // Unhandled
}

// ✅ Proper async handling
async function good() {
    try {
        const data = await fetchData();
        processResult(data);
    } catch (error) {
        Sentry.captureException(error);
        throw error;
    }
}
```

---

**Related Files:**
- [SKILL.md](../SKILL.md)
- [routing-and-controllers.md](routing-and-controllers.md)
- [async-and-errors.md](async-and-errors.md)
