# Async Patterns and Error Handling

Complete guide to async/await patterns and custom error handling.

## Table of Contents

- [Async/Await Best Practices](#asyncawait-best-practices)
- [Promise Error Handling](#promise-error-handling)
- [Custom Error Types](#custom-error-types)
- [The async route hazard, and how this repo answers it](#the-async-route-hazard-and-how-this-repo-answers-it)
- [Error Propagation](#error-propagation)
- [Common Async Pitfalls](#common-async-pitfalls)

---

## Async/Await Best Practices

### Always Use Try-Catch

```typescript
// ❌ NEVER: Unhandled async errors
async function fetchData() {
    const data = await database.query(); // If throws, unhandled!
    return data;
}

// ✅ ALWAYS: Wrap in try-catch
async function fetchData() {
    try {
        const data = await database.query();
        return data;
    } catch (error) {
        Sentry.captureException(error);
        throw error;
    }
}
```

### Avoid .then() Chains

```typescript
// ❌ AVOID: Promise chains
function processData() {
    return fetchData()
        .then(data => transform(data))
        .then(transformed => save(transformed))
        .catch(error => {
            console.error(error);
        });
}

// ✅ PREFER: Async/await
async function processData() {
    try {
        const data = await fetchData();
        const transformed = await transform(data);
        return await save(transformed);
    } catch (error) {
        Sentry.captureException(error);
        throw error;
    }
}
```

---

## Promise Error Handling

### Parallel Operations

```typescript
// ✅ Handle errors in Promise.all
try {
    const [users, profiles, settings] = await Promise.all([
        userService.getAll(),
        profileService.getAll(),
        settingsService.getAll(),
    ]);
} catch (error) {
    // One failure fails all
    Sentry.captureException(error);
    throw error;
}

// ✅ Handle errors individually with Promise.allSettled
const results = await Promise.allSettled([
    userService.getAll(),
    profileService.getAll(),
    settingsService.getAll(),
]);

results.forEach((result, index) => {
    if (result.status === 'rejected') {
        Sentry.captureException(result.reason, {
            tags: { operation: ['users', 'profiles', 'settings'][index] }
        });
    }
});
```

---

## Custom Error Types

### Define Custom Errors

```typescript
// Base error class
export class AppError extends Error {
    constructor(
        message: string,
        public code: string,
        public statusCode: number,
        public isOperational: boolean = true
    ) {
        super(message);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
}

// Specific error types
export class ValidationError extends AppError {
    constructor(message: string) {
        super(message, 'VALIDATION_ERROR', 400);
    }
}

export class NotFoundError extends AppError {
    constructor(message: string) {
        super(message, 'NOT_FOUND', 404);
    }
}

export class ForbiddenError extends AppError {
    constructor(message: string) {
        super(message, 'FORBIDDEN', 403);
    }
}

export class ConflictError extends AppError {
    constructor(message: string) {
        super(message, 'CONFLICT', 409);
    }
}
```

### Usage

```typescript
// Throw specific errors
if (!user) {
    throw new NotFoundError('User not found');
}

if (user.age < 18) {
    throw new ValidationError('User must be 18+');
}

// Error boundary handles them
function errorBoundary(error, req, res, next) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({
            error: {
                message: error.message,
                code: error.code
            }
        });
    }

    // Unknown error
    Sentry.captureException(error);
    res.status(500).json({ error: { message: 'Internal server error' } });
}
```

---

## The async route hazard, and how this repo answers it

This is Express `^4.21.1`. Express 4 **does not** catch a rejected promise returned from a handler,
so this is a genuine hole:

```typescript
// ❌ If getAll() rejects, nothing catches it. Not errorHandler.ts — it never runs.
router.get('/users', async (req, res) => {
    const users = await userService.getAll();
    res.json(users);
});
```

**This repo closes it in the controller, not with a wrapper.** Routes stay synchronous and discard
the promise explicitly; the controller is what guarantees the catch:

```typescript
// backend/src/routes/activity.ts
router.get('/', requireAuth, (req, res) => {
  void activityController.list(req, res);
});
```

```typescript
// the controller — this try/catch is the one that is NOT optional
async list(req: Request, res: Response): Promise<void> {
    try {
        this.handleSuccess(res, await activityService.list(req.userId));
    } catch (error) {
        this.handleError(error, res, 'list');
    }
}
```

The `void` is a deliberate signal, not sloppiness: it says "this promise is handled inside." It is
only true because `handleError` exists. **Never write an `async` route handler that awaits a
service directly.**

### ⚠️ The wrapper below does not exist in this repo

A `next(error)`-forwarding wrapper is the other standard answer, and earlier revisions of this file
presented it as if it were available here. It is not — there is no `asyncErrorWrapper` and no
`middleware/errorBoundary.ts`. Shown only so you recognise it elsewhere:

```typescript
export function asyncErrorWrapper(
    handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
    return (req: Request, res: Response, next: NextFunction) => {
        handler(req, res, next).catch(next);
    };
}
```

Adding it — or upgrading to Express 5, which catches rejections natively — is a change to propose,
not a pattern to assume.

---

## Error Propagation

### Proper Error Chains

```typescript
// ✅ Propagate errors up the stack
async function repositoryMethod() {
    try {
        return await db.selectFrom('users').selectAll().execute();
    } catch (error) {
        Sentry.captureException(error, { tags: { layer: 'repository' } });
        throw error; // Propagate to service
    }
}

async function serviceMethod() {
    try {
        return await repositoryMethod();
    } catch (error) {
        Sentry.captureException(error, { tags: { layer: 'service' } });
        throw error; // Propagate to controller
    }
}

async function controllerMethod(req, res) {
    try {
        const result = await serviceMethod();
        res.json(result);
    } catch (error) {
        this.handleError(error, res, 'controllerMethod'); // Final handler
    }
}
```

---

## Common Async Pitfalls

### Fire and Forget (Bad)

```typescript
// ❌ NEVER: Fire and forget
async function processRequest(req, res) {
    sendEmail(user.email); // Fires async, errors unhandled!
    res.json({ success: true });
}

// ✅ ALWAYS: Await or handle
async function processRequest(req, res) {
    try {
        await sendEmail(user.email);
        res.json({ success: true });
    } catch (error) {
        Sentry.captureException(error);
        res.status(500).json({ error: 'Failed to send email' });
    }
}

// ✅ OR: Intentional background task
async function processRequest(req, res) {
    sendEmail(user.email).catch(error => {
        Sentry.captureException(error);
    });
    res.json({ success: true });
}
```

### Unhandled Rejections

```typescript
// ✅ Global handler for unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
    Sentry.captureException(reason, {
        tags: { type: 'unhandled_rejection' }
    });
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    Sentry.captureException(error, {
        tags: { type: 'uncaught_exception' }
    });
    console.error('Uncaught Exception:', error);
    process.exit(1);
});
```

---

**Related Files:**
- [SKILL.md](../SKILL.md)
- [sentry-and-monitoring.md](sentry-and-monitoring.md)
- [complete-examples.md](complete-examples.md)
