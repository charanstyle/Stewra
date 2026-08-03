---
name: backend-dev-guidelines
description: Comprehensive backend development guide for Node.js/Express/TypeScript microservices. Use when creating routes, controllers, services, repositories, middleware, or working with Express APIs, Kysely database access, Sentry error tracking, Zod validation, unifiedConfig, dependency injection, or async patterns. Covers layered architecture (routes → controllers → services → repositories), BaseController pattern, error handling, performance monitoring, testing strategies, and migration from legacy patterns.
---

# Backend Development Guidelines

## Purpose

Establish consistency across `backend/` — a single Express 4 / TypeScript ESM service, not a set of
microservices. The sibling workspaces (`bridge/`, `runner/`, `provisioner/`) are separate processes
with their own conventions; this skill is about `backend/`.

## When to Use This Skill

Automatically activates when working on:
- Creating or modifying routes, endpoints, APIs
- Building controllers, services, repositories
- Implementing middleware (auth, validation, error handling)
- Database operations with Kysely
- Error tracking with Sentry
- Input validation with Zod
- Configuration management
- Backend testing and refactoring

---

## Quick Start

### New Backend Feature Checklist

- [ ] **Route**: Clean definition, delegate to controller
- [ ] **Controller**: Extend BaseController
- [ ] **Service**: Business logic with DI
- [ ] **Repository**: Database access (if complex)
- [ ] **Validation**: Zod schema
- [ ] **Sentry**: Error tracking
- [ ] **Tests**: Unit + integration tests
- [ ] **Config**: Use unifiedConfig

### New Microservice Checklist

- [ ] Directory structure (see [architecture-overview.md](resources/architecture-overview.md))
- [ ] instrument.ts for Sentry
- [ ] unifiedConfig setup
- [ ] BaseController class
- [ ] Middleware stack
- [ ] Error boundary
- [ ] Testing framework

---

## Architecture Overview

### Layered Architecture

```
HTTP Request
    ↓
Routes (routing only)
    ↓
Controllers (request handling)
    ↓
Services (business logic)
    ↓
Repositories (data access)
    ↓
Database (Kysely)
```

**Key Principle:** Each layer has ONE responsibility.

See [architecture-overview.md](resources/architecture-overview.md) for complete details.

---

## Directory Structure

`backend/src/`, as it actually is:

```
backend/src/
├── config/              # unifiedConfig.ts — Zod over process.env
├── controllers/         # Request handlers; all extend baseController
├── services/            # Business logic
├── repositories/        # Data access (Kysely)
├── routes/              # Route definitions — thin, delegate only
├── middleware/          # requireAuth, rateLimit, errorHandler, …
├── database/            # index.ts (the `db` handle), types.ts, migrations/
├── websocket/           # Socket.IO handlers
├── scheduler/           # setInterval-based recurring work
├── agent-host/          # ACP agent process management
├── control-plane/       # Hosted-runner control surface
├── types/               # TypeScript types
├── utils/               # errors.ts, logger.ts, …
├── tests/               # *.test.ts, colocated in one directory
├── instrument.ts        # Sentry (imported FIRST by index.ts)
├── app.ts               # Express setup
└── index.ts             # HTTP + Socket.IO server entrypoint
```

There is no `validators/` directory — Zod schemas live next to the controller or service that uses
them.

**Naming Conventions** — everything is `camelCase`, including files that export a class:

- Controllers: `activityController.ts`, `baseController.ts`
- Services: `hostedRunnerService.ts`
- Routes: bare resource name — `activity.ts`, `auth.ts`, `connections.ts` (no `Routes` suffix)
- Repositories: `bridgeDeviceRepository.ts`
- Tests: `<subject>.test.ts` in `backend/src/tests/`

---

## Core Principles (8 Key Rules)

### 1. API Contracts MUST Use @stewra/shared-types

**CRITICAL:** All API contracts between backend and frontend/website MUST use shared types from `@stewra/shared-types`.

```typescript
// ❌ NEVER: Define API types inline or in backend-only files
router.post('/users', async (req, res) => {
    const user: { name: string; email: string } = req.body;
});

// ✅ ALWAYS: Use shared types for all API contracts
import type { CreateUserRequest, UserResponse } from '@stewra/shared-types';

router.post('/users', async (req, res) => {
    const userData: CreateUserRequest = req.body;
    const user: UserResponse = await userService.create(userData);
    res.json(user);
});
```

**Why:** Ensures type safety across the entire stack. Frontend, mobile, and backend all use the same type definitions, preventing runtime errors from type mismatches.

**Applies to:**
- Request bodies
- Response bodies
- Query parameters (as interfaces)
- Route parameters (as interfaces)
- WebSocket message types
- All data crossing API boundaries

### 2. Routes Only Route, Controllers Control

```typescript
// ❌ NEVER: Business logic in routes
router.post('/submit', async (req, res) => {
    // 200 lines of logic
});

// ✅ ALWAYS: Delegate to controller
router.post('/submit', (req, res) => controller.submit(req, res));
```

### 3. All Controllers Extend BaseController

```typescript
export class UserController extends BaseController {
    async getUser(req: Request, res: Response): Promise<void> {
        try {
            const user = await this.userService.findById(req.params.id);
            this.handleSuccess(res, user);
        } catch (error) {
            this.handleError(error, res, 'getUser');
        }
    }
}
```

### 4. Let Errors Reach a Capture Point

`BaseController.handleError` already captures. So the rule is **do not swallow** — not *wrap
everything*:

```typescript
// ❌ Adds nothing the controller would not have captured, and hides that fact
try { await operation(); } catch (error) { Sentry.captureException(error); throw error; }

// ❌ Far worse — the failure no longer exists anywhere
try { return await operation(); } catch { return []; }

// ✅ Wrap only to add context the capture point cannot know, and always re-throw
try {
    await operation();
} catch (error) {
    Sentry.captureException(error, { tags: { service: 'gmailSync' }, extra: { connectionId } });
    throw error;
}
```

### 5. Use unifiedConfig, NEVER process.env

```typescript
// ❌ NEVER
const timeout = process.env.TIMEOUT_MS;

// ✅ ALWAYS
import { config } from './config/unifiedConfig';
const timeout = config.timeouts.default;
```

### 6. Validate All Input with Zod

```typescript
const schema = z.object({ email: z.string().email() });
const validated = schema.parse(req.body);
```

### 7. Use Repository Pattern for Data Access

```typescript
// Service → Repository → Database
const users = await userRepository.findActive();
```

### 8. Test Against Real Collaborators, Not Mocks

Vitest with `globals: true`, against a real Postgres and a real Redis. **Do not mock.**

```typescript
describe('userRepository', () => {
    it('rejects a duplicate email', async () => {
        await userRepository.create({ email: 'a@stewra.invalid', /* … */ });
        await expect(userRepository.create({ email: 'a@stewra.invalid', /* … */ }))
            .rejects.toThrow(ConflictError);
    });
});
```

See [testing-guide.md](resources/testing-guide.md), and `TESTING.md` at the repo root — which is
the authority.

---

## Common Imports

```typescript
// Express
import express, { Request, Response, NextFunction, Router } from 'express';

// Validation
import { z } from 'zod';

// Database — the shared handle, and the hand-written schema types
import { db } from '../database/index.js';
import type { Database, UsersTable } from '../database/types.js';
import type { Selectable } from 'kysely';

// Sentry
import * as Sentry from '@sentry/node';

// Config
import { config } from '../config/unifiedConfig.js';

// Errors — throw these; BaseController turns them into the right status
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors.js';

// Middleware
import { requireAuth } from '../middleware/requireAuth.js';

// Shared Types (REQUIRED for API contracts)
import type {
  CreateUserRequest,
  UserResponse,
  ApiResponse,
} from '@stewra/shared-types';
```

**The `.js` extensions are mandatory.** `backend` is ESM (`"type": "module"`), so TypeScript
sources import each other with a `.js` suffix that resolves to the emitted file. Omitting it
compiles and then fails at runtime.

There is no `SSOMiddleware`, no `errorBoundary`/`asyncErrorWrapper`, and no `types/database` —
earlier revisions of this file listed all three. The real middleware is
`requireAuth`, `requireEmailVerification`, `requireRunnerDevice`, `rateLimit`,
`verifyWhatsappSignature`, and `errorHandler`.

---

## Quick Reference

### HTTP Status Codes

| Code | Use Case |
|------|----------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 500 | Server Error |

### Templates to copy from

Read a real one rather than the abstractions above:

| For | Read |
|-----|------|
| A thin route | `backend/src/routes/activity.ts` (12 lines) |
| A controller | `backend/src/controllers/baseController.ts`, then any subclass |
| A repository with tenancy | `backend/src/repositories/bridgeDeviceRepository.ts` |
| A service with real collaborators under test | `backend/src/services/hostedRunnerService.ts` |

---

## Anti-Patterns to Avoid

❌ Business logic in routes
❌ Direct process.env usage
❌ Missing error handling
❌ No input validation
❌ Direct database queries everywhere (use repositories)
❌ console.log instead of Sentry

---

## Navigation Guide

| Need to... | Read this |
|------------|-----------|
| Understand architecture | [architecture-overview.md](resources/architecture-overview.md) |
| Create routes/controllers | [routing-and-controllers.md](resources/routing-and-controllers.md) |
| Organize business logic | [services-and-repositories.md](resources/services-and-repositories.md) |
| Validate input | [validation-patterns.md](resources/validation-patterns.md) |
| Add error tracking | [sentry-and-monitoring.md](resources/sentry-and-monitoring.md) |
| Create middleware | [middleware-guide.md](resources/middleware-guide.md) |
| Database access | [database-patterns.md](resources/database-patterns.md) |
| Manage config | [configuration.md](resources/configuration.md) |
| Handle async/errors | [async-and-errors.md](resources/async-and-errors.md) |
| Write tests | [testing-guide.md](resources/testing-guide.md) |
| See examples | [complete-examples.md](resources/complete-examples.md) |

---

## Resource Files

### [architecture-overview.md](resources/architecture-overview.md)
Layered architecture, request lifecycle, separation of concerns

### [routing-and-controllers.md](resources/routing-and-controllers.md)
Route definitions, BaseController, error handling, examples

### [services-and-repositories.md](resources/services-and-repositories.md)
Service patterns, DI, repository pattern, caching

### [validation-patterns.md](resources/validation-patterns.md)
Zod schemas, validation, DTO pattern

### [sentry-and-monitoring.md](resources/sentry-and-monitoring.md)
Sentry init, error capture, performance monitoring

### [middleware-guide.md](resources/middleware-guide.md)
Auth, audit, error boundaries, AsyncLocalStorage

### [database-patterns.md](resources/database-patterns.md)
Kysely query builder, repositories, transactions, migrations

### [configuration.md](resources/configuration.md)
UnifiedConfig, environment configs, secrets

### [async-and-errors.md](resources/async-and-errors.md)
Async patterns, the `AppError` hierarchy, why routes are synchronous and `void` the controller call

### [testing-guide.md](resources/testing-guide.md)
Vitest, real Postgres/Redis collaborators, why nothing here is mocked

### [complete-examples.md](resources/complete-examples.md)
Full examples, refactoring guide

---

## Related Skills

- **api-contract-validation** - Keeping request/response types in `@stewra/shared-types`
- **error-tracking** - Sentry integration patterns
- **skill-developer** - Meta-skill for creating and managing skills

There is no `database-verification` skill. To verify a table or column name, read the hand-written
`backend/src/database/types.ts` — it is the schema of record, and it is not generated, so it can
drift from the migrations under `backend/src/database/migrations/`. When the two disagree, the
migrations are the truth and `types.ts` is the bug.

---

**Skill Status**: COMPLETE ✅
**Line Count**: < 500 ✅
**Progressive Disclosure**: 11 resource files ✅
