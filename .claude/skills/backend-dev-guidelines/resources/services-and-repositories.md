# Services and Repositories - Business Logic Layer

Complete guide to organizing business logic with services and data access with repositories.

## Table of Contents

- [Service Layer Overview](#service-layer-overview)
- [Dependency Injection Pattern](#dependency-injection-pattern)
- [Singleton Pattern](#singleton-pattern)
- [Repository Pattern](#repository-pattern)
- [Service Design Principles](#service-design-principles)
- [Caching Strategies](#caching-strategies)
- [Testing Services](#testing-services)

---

## Service Layer Overview

### Purpose of Services

**Services contain business logic** - the 'what' and 'why' of your application:

```
Controller asks: "Should I do this?"
Service answers: "Yes/No, here's why, and here's what happens"
Repository executes: "Here's the data you requested"
```

**Services are responsible for:**
- ✅ Business rules enforcement
- ✅ Orchestrating multiple repositories
- ✅ Transaction management
- ✅ Complex calculations
- ✅ External service integration
- ✅ Business validations

**Services should NOT:**
- ❌ Know about HTTP (Request/Response)
- ❌ Direct `db` access (use repositories)
- ❌ Handle route-specific logic
- ❌ Format HTTP responses

---

## Dependency Injection Pattern

### Why Dependency Injection?

**Benefits:**
- Clear, enumerated dependencies
- Flexible configuration
- Promotes loose coupling
- Lets a test substitute a **real** alternative — a scripted HTTP server, a fake subprocess — at the
  seam. Note this is *not* "easy to inject mocks": mock collaborators are not used in this repo
  (see [testing-guide.md](testing-guide.md)). The seam exists so the substitute can be real.

Most services here simply import their repository singleton directly. Reach for constructor
injection when a collaborator genuinely varies — a transport, an external API client, a clock.

### Example: NotificationService

```typescript
// Define dependencies interface for clarity
export interface NotificationServiceDependencies {
    notificationRepository: NotificationRepository;
    batchingService: BatchingService;
    emailComposer: EmailComposer;
}

// Service with dependency injection
export class NotificationService {
    private notificationRepository: NotificationRepository;
    private batchingService: BatchingService;
    private emailComposer: EmailComposer;
    private preferencesCache: Map<string, { preferences: UserPreference; timestamp: number }> = new Map();
    private CACHE_TTL = (notificationConfig.preferenceCacheTTLMinutes || 5) * 60 * 1000;

    // Dependencies injected via constructor
    constructor(dependencies: NotificationServiceDependencies) {
        this.notificationRepository = dependencies.notificationRepository;
        this.batchingService = dependencies.batchingService;
        this.emailComposer = dependencies.emailComposer;
    }

    /**
     * Create a notification and route it appropriately
     */
    async createNotification(params: CreateNotificationParams) {
        const { recipientID, type, title, message, link, context = {}, channel = 'both', priority = NotificationPriority.NORMAL } = params;

        try {
            // Get template and render content
            const template = getNotificationTemplate(type);
            const rendered = renderNotificationContent(template, context);

            // Create in-app notification record
            const notificationId = await createNotificationRecord({
                instanceId: parseInt(context.instanceId || '0', 10),
                template: type,
                recipientUserId: recipientID,
                channel: channel === 'email' ? 'email' : 'inApp',
                contextData: context,
                title: finalTitle,
                message: finalMessage,
                link: finalLink,
            });

            // Route notification based on channel
            if (channel === 'email' || channel === 'both') {
                await this.routeNotification({
                    notificationId,
                    userId: recipientID,
                    type,
                    priority,
                    title: finalTitle,
                    message: finalMessage,
                    link: finalLink,
                    context,
                });
            }

            return notification;
        } catch (error) {
            ErrorLogger.log(error, {
                context: {
                    '[NotificationService] createNotification': {
                        type: params.type,
                        recipientID: params.recipientID,
                    },
                },
            });
            throw error;
        }
    }

    /**
     * Route notification based on user preferences
     */
    private async routeNotification(params: { notificationId: number; userId: string; type: string; priority: NotificationPriority; title: string; message: string; link?: string; context?: Record<string, any> }) {
        // Get user preferences with caching
        const preferences = await this.getUserPreferences(params.userId);

        // Check if we should batch or send immediately
        if (this.shouldBatchEmail(preferences, params.type, params.priority)) {
            await this.batchingService.queueNotificationForBatch({
                notificationId: params.notificationId,
                userId: params.userId,
                userPreference: preferences,
                priority: params.priority,
            });
        } else {
            // Send immediately via EmailComposer
            await this.sendImmediateEmail({
                userId: params.userId,
                title: params.title,
                message: params.message,
                link: params.link,
                context: params.context,
                type: params.type,
            });
        }
    }

    /**
     * Determine if email should be batched
     */
    shouldBatchEmail(preferences: UserPreference, notificationType: string, priority: NotificationPriority): boolean {
        // HIGH priority always immediate
        if (priority === NotificationPriority.HIGH) {
            return false;
        }

        // Check batch mode
        const batchMode = preferences.emailBatchMode || BatchMode.IMMEDIATE;
        return batchMode !== BatchMode.IMMEDIATE;
    }

    /**
     * Get user preferences with caching
     */
    async getUserPreferences(userId: string): Promise<UserPreference> {
        // Check cache first
        const cached = this.preferencesCache.get(userId);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.preferences;
        }

        const preference = await this.notificationRepository.findPreferences(userId);

        const finalPreferences = preference || DEFAULT_PREFERENCES;

        // Update cache
        this.preferencesCache.set(userId, {
            preferences: finalPreferences,
            timestamp: Date.now(),
        });

        return finalPreferences;
    }
}
```

**Usage in Controller:**

```typescript
// Instantiate with dependencies
const notificationService = new NotificationService({
    notificationRepository,
    batchingService: new BatchingService(notificationRepository),
    emailComposer: new EmailComposer(),
});

// Use in controller
const notification = await notificationService.createNotification({
    recipientID: 'user-123',
    type: 'AFRLWorkflowNotification',
    context: { workflowName: 'AFRL Monthly Report' },
});
```

**Key Takeaways:**
- Dependencies passed via constructor
- Clear interface defines required dependencies
- Easy to test (inject mocks)
- Encapsulated caching logic
- Business rules isolated from HTTP

---

## Singleton Pattern

### When to Use Singletons

**Use for:**
- Services with expensive initialization
- Services with shared state (caching)
- Services accessed from many places
- Permission services
- Configuration services

### Example: PermissionService (Singleton)

```typescript
import { postRepository } from '../repositories/postRepository.js';

class PermissionService {
    private static instance: PermissionService;
    private permissionCache: Map<string, { canAccess: boolean; timestamp: number }> = new Map();
    private CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    // Private constructor prevents direct instantiation
    private constructor() {}

    // Get singleton instance
    public static getInstance(): PermissionService {
        if (!PermissionService.instance) {
            PermissionService.instance = new PermissionService();
        }
        return PermissionService.instance;
    }

    /**
     * Check if user can complete a workflow step
     */
    async canCompleteStep(userId: string, stepInstanceId: number): Promise<boolean> {
        const cacheKey = `${userId}:${stepInstanceId}`;

        // Check cache
        const cached = this.permissionCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.canAccess;
        }

        try {
            const post = await postRepository.findWithAuthorAndComments(postId);

            if (!post) {
                return false;
            }

            // Check if user has permission
            const canEdit = post.authorId === userId ||
                await this.isUserAdmin(userId);

            // Cache result
            this.permissionCache.set(cacheKey, {
                canAccess: isAssigned,
                timestamp: Date.now(),
            });

            return isAssigned;
        } catch (error) {
            console.error('[PermissionService] Error checking step permission:', error);
            return false;
        }
    }

    /**
     * Clear cache for user
     */
    clearUserCache(userId: string): void {
        for (const [key] of this.permissionCache) {
            if (key.startsWith(`${userId}:`)) {
                this.permissionCache.delete(key);
            }
        }
    }

    /**
     * Clear all cache
     */
    clearCache(): void {
        this.permissionCache.clear();
    }
}

// Export singleton instance
export const permissionService = PermissionService.getInstance();
```

**Usage:**

```typescript
import { permissionService } from '../services/permissionService';

// Use anywhere in the codebase
const canComplete = await permissionService.canCompleteStep(userId, stepId);

if (!canComplete) {
    throw new ForbiddenError('You do not have permission to complete this step');
}
```

---

## Repository Pattern

### Purpose of Repositories

**Repositories abstract data access** - the 'how' of data operations:

```
Service: "Get me all active users sorted by name"
Repository: "Here's the Kysely query that does that"
```

**Repositories are responsible for:**
- ✅ All database access (the only layer that imports `db`)
- ✅ Query construction
- ✅ Row → domain model mapping (`toModel`)
- ✅ Tenancy scoping, in the `WHERE` clause
- ✅ Translating constraint violations into domain errors

**Repositories should NOT:**
- ❌ Contain business logic
- ❌ Know about HTTP
- ❌ Make decisions (that's service layer)

### Repository Template

Note what is **absent** below: there is no `try/catch` around a query that logs and rethrows a new
generic `Error`. That pattern looks defensive and is actively harmful — it discards the original
error, its stack, and the Postgres SQLSTATE, so the caller sees "Failed to find user" and no way to
learn that the real cause was a dropped column or a dead connection. Let the error propagate. Catch
only where you have a genuine domain answer (a specific constraint violation), and rethrow everything
else untouched.

```typescript
// repositories/userRepository.ts
import { DatabaseError } from 'pg';
import type { Selectable } from 'kysely';
import { db } from '../database/index.js';
import type { UsersTable } from '../database/types.js';
import { ConflictError } from '../utils/errors.js';
import type { User } from '@stewra/shared-types';

/** snake_case row → camelCase domain model. Raw rows never leave this file. */
function toModel(row: Selectable<UsersTable>): User {
    return {
        id: row.id,
        email: row.email,
        name: row.display_name,
        isActive: row.is_active,
        role: row.role,
        createdAt: row.created_at.toISOString(),
    };
}

const MODEL_COLUMNS = ['id', 'email', 'display_name', 'is_active', 'role', 'created_at'] as const;

export class UserRepository {
    /** Zero-or-one. `null` is an honest answer here; `{}` or a placeholder user would not be. */
    async findById(userId: string): Promise<User | null> {
        const row = await db
            .selectFrom('users')
            .select(MODEL_COLUMNS)
            .where('id', '=', userId)
            .executeTakeFirst();
        return row ? toModel(row) : null;
    }

    async findActive(orderBy: 'display_name' | 'created_at' = 'display_name'): Promise<User[]> {
        const rows = await db
            .selectFrom('users')
            .select(MODEL_COLUMNS)
            .where('is_active', '=', true)
            .orderBy(orderBy, 'asc')
            .execute();
        return rows.map(toModel);
    }

    async findByEmail(email: string): Promise<User | null> {
        const row = await db
            .selectFrom('users')
            .select(MODEL_COLUMNS)
            .where('email', '=', email)
            .executeTakeFirst();
        return row ? toModel(row) : null;
    }

    /**
     * The one place a catch is justified: `23505` on the email unique index is a fact the caller can
     * act on, so it becomes a domain error. Everything else propagates with its cause intact.
     */
    async create(input: CreateUserInput): Promise<User> {
        try {
            const row = await db
                .insertInto('users')
                .values({
                    email: input.email,
                    display_name: input.name,
                    password_hash: input.passwordHash,
                    role: 'user',
                })
                .returning(MODEL_COLUMNS)
                .executeTakeFirstOrThrow();
            return toModel(row);
        } catch (error) {
            if (error instanceof DatabaseError && error.code === '23505') {
                throw new ConflictError('Email already registered');
            }
            throw error;
        }
    }

    async update(userId: string, changes: UpdateUserInput): Promise<User> {
        const row = await db
            .updateTable('users')
            .set({ display_name: changes.name, updated_at: sql`now()` })
            .where('id', '=', userId)
            .returning(MODEL_COLUMNS)
            .executeTakeFirstOrThrow();   // no row updated = the id was wrong; that must be loud
        return toModel(row);
    }

    /** Soft delete. Returns whether it changed anything, rather than pretending it always did. */
    async deactivate(userId: string): Promise<boolean> {
        const result = await db
            .updateTable('users')
            .set({ is_active: false })
            .where('id', '=', userId)
            .executeTakeFirst();
        return Number(result.numUpdatedRows) > 0;
    }

    /** A predicate answering its own question — a boolean is a complete answer, so no null needed. */
    async emailExists(email: string): Promise<boolean> {
        const row = await db
            .selectFrom('users')
            .select('id')
            .where('email', '=', email)
            .executeTakeFirst();
        return row !== undefined;
    }
}

// Export singleton instance
export const userRepository = new UserRepository();
```

**Using Repository in Service:**

```typescript
// services/userService.ts
import { userRepository } from '../repositories/UserRepository';
import { ConflictError, NotFoundError } from '../utils/errors';

export class UserService {
    /**
     * Create new user with business rules
     */
    async createUser(data: { email: string; name: string; roles: string[] }): Promise<User> {
        // Business rule: Check if email already exists
        const emailExists = await userRepository.emailExists(data.email);
        if (emailExists) {
            throw new ConflictError('Email already exists');
        }

        // Business rule: Validate roles
        const validRoles = ['admin', 'operations', 'user'];
        const invalidRoles = data.roles.filter((role) => !validRoles.includes(role));
        if (invalidRoles.length > 0) {
            throw new ValidationError(`Invalid roles: ${invalidRoles.join(', ')}`);
        }

        // Create user via repository
        return await userRepository.create({
            email: data.email,
            name: data.name,
            roles: data.roles,
            isActive: true,
        });
    }

    /**
     * Get user by ID
     */
    async getUser(userId: string): Promise<User> {
        const user = await userRepository.findById(userId);

        if (!user) {
            throw new NotFoundError(`User not found: ${userId}`);
        }

        return user;
    }
}
```

---

## Service Design Principles

### 1. Single Responsibility

Each service should have ONE clear purpose:

```typescript
// ✅ GOOD - Single responsibility
class UserService {
    async createUser() {}
    async updateUser() {}
    async deleteUser() {}
}

class EmailService {
    async sendEmail() {}
    async sendBulkEmails() {}
}

// ❌ BAD - Too many responsibilities
class UserService {
    async createUser() {}
    async sendWelcomeEmail() {}  // Should be EmailService
    async logUserActivity() {}   // Should be AuditService
    async processPayment() {}    // Should be PaymentService
}
```

### 2. Clear Method Names

Method names should describe WHAT they do:

```typescript
// ✅ GOOD - Clear intent
async createNotification()
async getUserPreferences()
async shouldBatchEmail()
async routeNotification()

// ❌ BAD - Vague or misleading
async process()
async handle()
async doIt()
async execute()
```

### 3. Return Types

Always use explicit return types:

```typescript
// ✅ GOOD - Explicit types
async createUser(data: CreateUserDTO): Promise<User> {}
async findUsers(): Promise<User[]> {}
async deleteUser(id: string): Promise<void> {}

// ❌ BAD - Implicit any
async createUser(data) {}  // No types!
```

### 4. Error Handling

Services should throw meaningful errors:

```typescript
// ✅ GOOD - Meaningful errors
if (!user) {
    throw new NotFoundError(`User not found: ${userId}`);
}

if (emailExists) {
    throw new ConflictError('Email already exists');
}

// ❌ BAD - Generic errors
if (!user) {
    throw new Error('Error');  // What error?
}
```

### 5. Avoid God Services

Don't create services that do everything:

```typescript
// ❌ BAD - God service
class WorkflowService {
    async startWorkflow() {}
    async completeStep() {}
    async assignRoles() {}
    async sendNotifications() {}  // Should be NotificationService
    async validatePermissions() {}  // Should be PermissionService
    async logAuditTrail() {}  // Should be AuditService
    // ... 50 more methods
}

// ✅ GOOD - Focused services
class WorkflowService {
    constructor(
        private notificationService: NotificationService,
        private permissionService: PermissionService,
        private auditService: AuditService
    ) {}

    async startWorkflow() {
        // Orchestrate other services
        await this.permissionService.checkPermission();
        await this.workflowRepository.create();
        await this.notificationService.notify();
        await this.auditService.log();
    }
}
```

---

## Caching Strategies

### 1. In-Memory Caching

```typescript
class UserService {
    private cache: Map<string, { user: User; timestamp: number }> = new Map();
    private CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    async getUser(userId: string): Promise<User> {
        // Check cache
        const cached = this.cache.get(userId);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.user;
        }

        // Fetch from database
        const user = await userRepository.findById(userId);

        // Update cache
        if (user) {
            this.cache.set(userId, { user, timestamp: Date.now() });
        }

        return user;
    }

    clearUserCache(userId: string): void {
        this.cache.delete(userId);
    }
}
```

### 2. Cache Invalidation

```typescript
class UserService {
    async updateUser(userId: string, data: UpdateUserDTO): Promise<User> {
        // Update in database
        const user = await userRepository.update(userId, data);

        // Invalidate cache
        this.clearUserCache(userId);

        return user;
    }
}
```

---

## Testing Services

See **[testing-guide.md](testing-guide.md)**, and `TESTING.md` at the repo root behind it.

The short version, because it inverts what most guides say: **do not mock the repository.** A service
test built on a stubbed repository asserts that a call was made and says nothing about whether the
SQL is valid, the column exists, or the transaction rolls back. Backend suites here run against the
real `stewra_test` Postgres and real Redis db 15 over `npm run tunnel`, insert their own fixtures,
and delete them in `afterAll`. The runner is Vitest — Jest is not a dependency in any workspace.

---

**Related Files:**
- [SKILL.md](../SKILL.md) - Main guide
- [routing-and-controllers.md](routing-and-controllers.md) - Controllers that use services
- [testing-guide.md](testing-guide.md) - How tests are written here (Vitest, real collaborators)
- [database-patterns.md](database-patterns.md) - Repository and query patterns
- [complete-examples.md](complete-examples.md) - Full service/repository examples
