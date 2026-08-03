# Middleware Guide - Express Middleware Patterns

Complete guide to creating and using middleware in backend microservices.

## Table of Contents

- [Authentication Middleware](#authentication-middleware)
- [Audit Middleware with AsyncLocalStorage](#audit-middleware-with-asynclocalstorage)
- [Error Boundary Middleware](#error-boundary-middleware)
- [Validation Middleware](#validation-middleware)
- [Composable Middleware](#composable-middleware)
- [Middleware Ordering](#middleware-ordering)

---

## Authentication Middleware

**File:** `backend/src/middleware/requireAuth.ts` — the real one, in full:

```typescript
/** Requires a valid access token. Sets req.userId on success; otherwise passes an error onward. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) {
    next(new AuthenticationError('Missing or malformed Authorization header'));
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    req.userId = authService.verifyToken(token, 'access');
    next();
  } catch (error) {
    next(error);
  }
}
```

Three conventions to copy from it:

- **It calls `next(error)`; it never writes a response.** Rendering is `errorHandler`'s job, so
  every failure comes out in the same `ApiResponse` shape. A middleware that calls
  `res.status(401).json(...)` itself produces a body the client's types do not describe.
- **It throws a typed `AuthenticationError`,** not a bare `Error` and not a status code. The
  status comes from the error class.
- **Identity lands on `req.userId`,** not `res.locals`. Downstream code reads `req.userId`.

The other middleware in `backend/src/middleware/` — `requireEmailVerification`,
`requireRunnerDevice`, `rateLimit`, `verifyWhatsappSignature` — all follow the same shape.

There is **no** `SSOMiddleware`, no Keycloak, no cookie-based `refresh_token` check in middleware,
and no `res.locals.claims`. Earlier revisions of this guide described all of them.

---

## Auditing — explicit calls, not middleware

There is **no audit middleware** and no `AsyncLocalStorage` anywhere in `backend/src`. Auditing is
an explicit call from the service that performed the action, through
`backend/src/control-plane/audit/auditWriter.ts`:

```typescript
/**
 * Appends to the immutable audit log. For a trust-first product there are NO unaudited actions:
 * if the write fails, this THROWS (we do not silently swallow). The table itself rejects any
 * later UPDATE/DELETE at the DB level.
 */
export class AuditWriter {
  async write(event: NewAuditEvent): Promise<AuditEvent> {
    const row = await db.insertInto('audit_log').values({ /* … */ })
      .returning([/* … */])
      .executeTakeFirstOrThrow();
    // … maps snake_case row → camelCase AuditEvent from @stewra/shared-types
  }
}

export const auditWriter = new AuditWriter();
```

Three deliberate properties:

- **A failed audit write throws.** It does not warn-and-continue. An action that could not be
  recorded did not happen as far as the product is concerned.
- **The table rejects `UPDATE`/`DELETE` at the database level** (migration `002_audit_log`), so
  append-only is enforced below the application, not by convention.
- **`executeTakeFirstOrThrow`, not `executeTakeFirst`.** A missing row here is not an honest
  `undefined` — it is a failure.

Because rows reference `users.id` with `ON DELETE SET NULL`, a user who has ever been audited
cannot be hard-deleted. The test fixtures work around this deliberately — see
`backend/src/tests/githubAppService.test.ts:261`.

### ⚠️ Reference only — the AsyncLocalStorage pattern below is not used here

Kept because it is the right shape *if* per-request ambient context is ever needed. It is not
present today.

```typescript
import { AsyncLocalStorage } from 'async_hooks';

export interface AuditContext {
    userId: string;
    userName?: string;
    impersonatedBy?: string;
    sessionId?: string;
    timestamp: Date;
    requestId: string;
}

export const auditContextStorage = new AsyncLocalStorage<AuditContext>();

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
    const context: AuditContext = {
        userId: res.locals.effectiveUserId || 'anonymous',
        userName: res.locals.claims?.preferred_username,
        impersonatedBy: res.locals.isImpersonating ? res.locals.originalUserId : undefined,
        timestamp: new Date(),
        requestId: req.id || uuidv4(),
    };

    auditContextStorage.run(context, () => {
        next();
    });
}

// Getter for current context
export function getAuditContext(): AuditContext | null {
    return auditContextStorage.getStore() || null;
}
```

**Benefits:**
- Context propagates through entire request
- No need to pass context through every function
- Automatically available in services, repositories
- Type-safe context access

**Usage in Services:**
```typescript
import { getAuditContext } from '../middleware/auditMiddleware';

async function someOperation() {
    const context = getAuditContext();
    console.log('Operation by:', context?.userId);
}
```

---

## Error Boundary Middleware

**File:** `backend/src/middleware/errorHandler.ts` — the terminal error middleware, in full:

```typescript
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    const details =
      err instanceof ValidationError ? err.details.map((d) => ({ field: d.field, message: d.message })) : [];
    const body: ApiResponse<never> = {
      success: false,
      error: { code: err.code, message: err.message, details },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  Sentry.captureException(err);
  logger.error('Unhandled error', { error: err instanceof Error ? err.message : String(err) });
  const body: ApiResponse<never> = {
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', details: [] },
  };
  res.status(500).json(body);
}
```

The same file exports `notFoundHandler`, a terminal 404 in the same `ApiResponse` shape.

### Two things that will surprise you

**1. An `AppError` reaching *here* is not captured to Sentry** — it returns early, before line 28.
That is intentional: a `NotFoundError` from `requireAuth` is a normal outcome, not an incident.

But `BaseController.handleError` calls `captureException` **unconditionally**, before its own
`AppError` check. So the same `NotFoundError` *is* captured when it comes from a controller. If you
are counting 404s in Sentry, that asymmetry is why the numbers do not add up.

**2. This is not a safety net for async controllers.** Express `^4.21.1` does not catch rejected
promises, and routes are written as `void controller.method(req, res)`. A rejection escaping a
controller becomes an `unhandledRejection` and never reaches this middleware. See
[async-and-errors.md](async-and-errors.md).

This middleware's real job is synchronous throws and `next(err)` out of middleware.

---

## Composable Middleware

### withAuthAndAudit Pattern

```typescript
export function withAuthAndAudit(...authMiddleware: any[]) {
    return [
        ...authMiddleware,
        auditMiddleware,
    ];
}

// Usage
router.post('/:formID/submit',
    ...withAuthAndAudit(SSOMiddlewareClient.verifyLoginStatus),
    async (req, res) => controller.submit(req, res)
);
```

---

## Middleware Ordering

### Critical Order (Must Follow)

```typescript
// 1. Sentry request handler (FIRST)
app.use(Sentry.Handlers.requestHandler());

// 2. Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Cookie parsing
app.use(cookieParser());

// 4. Auth initialization
app.use(SSOMiddleware.initialize());

// 5. Routes registered here
app.use('/api/users', userRoutes);

// 6. Error handler (AFTER routes)
app.use(errorBoundary);

// 7. Sentry error handler (LAST)
app.use(Sentry.Handlers.errorHandler());
```

**Rule:** Error handlers MUST be registered AFTER all routes!

---

**Related Files:**
- [SKILL.md](../SKILL.md)
- [routing-and-controllers.md](routing-and-controllers.md)
- [async-and-errors.md](async-and-errors.md)
