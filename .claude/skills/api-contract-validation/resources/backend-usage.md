# Backend API Contract Usage

## Controller Usage

**File**: `backend/src/controllers/userController.ts`

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

## Service Usage

**File**: `backend/src/services/userService.ts`

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
import { prisma } from '@/config/database';
import { hashPassword, generateTokens } from '@/utils/auth';

export class UserService {
  async createUser(data: CreateUserRequest): Promise<CreateUserResponse> {
    const hashedPassword = await hashPassword(data.password);

    const user = await prisma.user.create({
      data: {
        username: data.username,
        email: data.email,
        password: hashedPassword,
        firstName: data.firstName,
        lastName: data.lastName
      }
    });

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

    const user = await prisma.user.update({
      where: { userId: data.userId },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        bio: data.bio,
        profilePicture: data.profilePicture
      }
    });

    return this.mapToUser(user);
  }

  async getUser(data: GetUserRequest): Promise<User> {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { userId: data.userId },
          { username: data.username }
        ]
      }
    });

    if (!user) {
      throw new Error('User not found');
    }

    return this.mapToUser(user);
  }

  async listUsers(data: ListUsersRequest): Promise<ListUsersResponse> {
    const page = data.page || 1;
    const pageSize = data.pageSize || 20;
    const skip = (page - 1) * pageSize;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where: data.search ? {
          OR: [
            { username: { contains: data.search, mode: 'insensitive' } },
            { firstName: { contains: data.search, mode: 'insensitive' } },
            { lastName: { contains: data.search, mode: 'insensitive' } }
          ]
        } : undefined,
        skip,
        take: pageSize,
        orderBy: data.sortBy ? { [data.sortBy]: data.sortOrder || 'asc' } : undefined
      }),
      prisma.user.count({
        where: data.search ? {
          OR: [
            { username: { contains: data.search } },
            { firstName: { contains: data.search } },
            { lastName: { contains: data.search } }
          ]
        } : undefined
      })
    ]);

    return {
      users: users.map(u => this.mapToUser(u)),
      total,
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
