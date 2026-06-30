# Shared Types Integration

## Project Architecture

### Shared Types Package

**Location**: `packages/shared-types/`

The shared-types package is the single source of truth for all API contracts.

**Structure**:
```
packages/shared-types/
├── src/
│   ├── api/           # API contract definitions (Request/Response types)
│   │   ├── auth.ts
│   │   ├── user.ts
│   │   ├── chat.ts
│   │   ├── payment.ts
│   │   └── ...
│   ├── models/        # Domain models
│   ├── schemas/       # Zod validation schemas
│   └── index.ts       # Main export file
├── package.json
└── tsconfig.json
```

**Key Points**:
- Versioned package: `@stewra/shared-types@1.0.0`
- Used as npm dependency in backend, frontend, and website
- Changes require rebuild: `cd packages/shared-types && npm run build`
- All three services must use the same version

## API Contract Patterns

### 1. Define Types in Shared-Types

**File**: `packages/shared-types/src/api/{domain}.ts`

```typescript
/**
 * User API Types
 */

import { PaginationParams } from './base';
import { User } from '../models/user';

// Create User
export interface CreateUserRequest {
  username: string;
  email: string;
  password: string;
  firstName: string;
  lastName?: string;
}

export interface CreateUserResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

// Update User
export interface UpdateUserRequest {
  userId?: number;
  firstName?: string;
  lastName?: string;
  bio?: string;
  profilePicture?: string;
}

export interface UpdateUserResponse {
  user: User;
  message: string;
}

// Get User
export interface GetUserRequest {
  userId?: number;
  username?: string;
}

export interface GetUserResponse {
  user: User;
}

// List Users
export interface ListUsersRequest extends PaginationParams {
  search?: string;
  sortBy?: 'created_at' | 'username' | 'ranking';
  sortOrder?: 'asc' | 'desc';
}

export interface ListUsersResponse {
  users: User[];
  total: number;
  page: number;
  pageSize: number;
}
```

## Common Base Types

```typescript
// packages/shared-types/src/api/base.ts

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PaginationParams {
  page?: number;
  pageSize?: number;
  limit?: number;
  offset?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}
```

## CRUD Pattern Template

For each domain entity, define:

1. **Create**: `Create{Entity}Request` + `Create{Entity}Response`
2. **Read (single)**: `Get{Entity}Request` + `Get{Entity}Response`
3. **Read (list)**: `List{Entity}Request` + `List{Entity}Response`
4. **Update**: `Update{Entity}Request` + `Update{Entity}Response`
5. **Delete**: `Delete{Entity}Request` + `Delete{Entity}Response`

## File Organization

```
packages/shared-types/src/api/
├── auth.ts          # Authentication endpoints
├── user.ts          # User management
├── chat.ts          # Chat/messaging
├── payment.ts       # Payment/subscription
├── social.ts        # Social features
├── ranking.ts       # Ranking system
├── notification.ts  # Notifications
├── media.ts         # Media upload/management
├── admin.ts         # Admin operations
└── base.ts          # Common types (ApiResponse, PaginationParams)
```
