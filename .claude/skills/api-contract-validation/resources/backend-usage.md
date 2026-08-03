# Backend API Contract Usage

> **Read the corrections after each block.** The examples below illustrate *shared-type usage* and
> are otherwise **not** this repo's conventions — `userController.ts` and `userService.ts` do not
> exist. For the real controller shape, read `backend/src/controllers/activityController.ts`.

## Controller Usage

**Illustrative** — no such file.

```typescript
import { Request, Response } from 'express';
import {
  CreateUserRequest,
  CreateUserResponse,
  UpdateUserRequest,
  UpdateUserResponse,
  GetUserResponse,
  ListUsersRequest,
  ListUsersResponse
} from '@stewra/shared-types';
import { BaseController } from '@/core/BaseController';
import { userService } from '@/services/userService';

export class UserController extends BaseController {
  async createUser(req: Request, res: Response): Promise<void> {
    const requestData = req.body as CreateUserRequest;

    const result = await userService.createUser(requestData);

    const response: CreateUserResponse = {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken
    };

    this.sendSuccess(res, response, 'User created successfully', 201);
  }

  async updateUser(req: Request, res: Response): Promise<void> {
    const requestData: UpdateUserRequest = {
      userId: parseInt(req.params.userId),
      ...req.body
    };

    const user = await userService.updateUser(requestData);

    const response: UpdateUserResponse = {
      user,
      message: 'User updated successfully'
    };

    this.sendSuccess(res, response);
  }

  async getUser(req: Request, res: Response): Promise<void> {
    const requestData: GetUserRequest = {
      userId: req.params.userId ? parseInt(req.params.userId) : undefined,
      username: req.query.username as string | undefined
    };

    const user = await userService.getUser(requestData);

    const response: GetUserResponse = { user };

    this.sendSuccess(res, response);
  }

  async listUsers(req: Request, res: Response): Promise<void> {
    const requestData = req.query as unknown as ListUsersRequest;

    const result = await userService.listUsers(requestData);

    const response: ListUsersResponse = result;

    this.sendSuccess(res, response);
  }
}
```

### Four things above that are wrong for this repo

1. **`req.body as CreateUserRequest` is a cast, not validation.** A cast asserts a shape over
   untrusted input without checking it — the exact failure the shared types are meant to prevent.
   Parse it: `const data = parse(createUserSchema, req.body)`. Same for
   `req.query as unknown as ListUsersRequest`, where the double cast is the tell.
2. **`sendSuccess` does not exist.** `BaseController` exposes `handleSuccess(res, data, statusCode)`
   and `handleError(error, res, context)`. There is no message argument — the response shape is
   `ApiResponse<T>`, which has no `message` field.
3. **There is no `@/` path alias.** `backend` is ESM with relative imports and mandatory `.js`
   extensions: `import { BaseController } from './baseController.js'`.
4. **Every method is missing its `try`/`catch`.** Express 4 does not catch rejected promises and
   routes call controllers as `void controller.method(req, res)`, so an un-caught rejection here
   becomes an `unhandledRejection` rather than a 500.

What the block *does* get right, and the reason it exists: request and response types both come
from `@stewra/shared-types`, and the response is annotated (`const response: CreateUserResponse =`)
so a drift between backend and client is a compile error rather than a runtime surprise.

## Service Usage

**Illustrative** — no such file.

```typescript
import {
  CreateUserRequest,
  CreateUserResponse,
  UpdateUserRequest,
  GetUserRequest,
  ListUsersRequest,
  ListUsersResponse,
  User
} from '@stewra/shared-types';
import { db } from '../database/index.js';
import { hashPassword, generateTokens } from '@/utils/auth';

export class UserService {
  async createUser(data: CreateUserRequest): Promise<CreateUserResponse> {
    const hashedPassword = await hashPassword(data.password);

    const user = await db
      .insertInto('users')
      .values({
        username: data.username,
        email: data.email,
        password_hash: hashedPassword,
        first_name: data.firstName,
        last_name: data.lastName
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const tokens = generateTokens(user.userId);

    return {
      user: this.mapToUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    };
  }

  async updateUser(data: UpdateUserRequest): Promise<User> {
    if (!data.userId) {
      throw new Error('User ID is required');
    }

    const user = await db
      .updateTable('users')
      .set({
        first_name: data.firstName,
        last_name: data.lastName,
        bio: data.bio,
        profile_picture: data.profilePicture
      })
      .where('id', '=', data.userId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapToUser(user);
  }

  async getUser(data: GetUserRequest): Promise<User> {
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('id', '=', data.userId),
          eb('username', '=', data.username)
        ])
      )
      .executeTakeFirst();

    if (!user) {
      throw new Error('User not found');
    }

    return this.mapToUser(user);
  }

  async listUsers(data: ListUsersRequest): Promise<ListUsersResponse> {
    const page = data.page || 1;
    const pageSize = data.pageSize || 20;
    const skip = (page - 1) * pageSize;

    // One predicate, shared by the page query and the count, so the two can never disagree
    // about what is being counted.
    const matchesSearch = (eb: ExpressionBuilder<Database, 'users'>) =>
      eb.or([
        eb('username', 'ilike', `%${data.search}%`),
        eb('first_name', 'ilike', `%${data.search}%`),
        eb('last_name', 'ilike', `%${data.search}%`)
      ]);
    const hasSearch = data.search !== undefined && data.search.length > 0;

    const [users, counted] = await Promise.all([
      db
        .selectFrom('users')
        .selectAll()
        .$if(hasSearch, (q) => q.where(matchesSearch))
        .$if(data.sortBy !== undefined, (q) => q.orderBy(data.sortBy, data.sortOrder ?? 'asc'))
        .offset(skip)
        .limit(pageSize)
        .execute(),
      db
        .selectFrom('users')
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .$if(hasSearch, (q) => q.where(matchesSearch))
        .executeTakeFirstOrThrow()
    ]);

    return {
      users: users.map(u => this.mapToUser(u)),
      // Postgres COUNT(*) is bigint, which `pg` hands back as a string — parse it, never cast it.
      total: Number(counted.total),
      page,
      pageSize
    };
  }

  private mapToUser(dbUser: unknown): User {
    // Map database user to User type
    // Implementation details...
    return dbUser as User;
  }
}

export const userService = new UserService();
```

## Best Practices for Backend

1. **Always import from @stewra/shared-types**
   ```typescript
   import { CreateUserRequest, UserResponse } from '@stewra/shared-types';
   ```

2. **Type request data explicitly**
   ```typescript
   const requestData = req.body as CreateUserRequest;
   ```

3. **Use shared types in service signatures**
   ```typescript
   async createUser(data: CreateUserRequest): Promise<CreateUserResponse>
   ```

4. **Return properly typed responses**
   ```typescript
   const response: CreateUserResponse = { user, accessToken, refreshToken };
   this.sendSuccess(res, response);
   ```

5. **Validate with Zod schemas matching shared types**
   ```typescript
   import { createUserSchema } from '@stewra/shared-types/schemas';
   const validated = createUserSchema.parse(req.body);
   ```
