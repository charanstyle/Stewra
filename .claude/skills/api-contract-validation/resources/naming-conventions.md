# Naming Conventions & Anti-Patterns

## API Contract Type Naming

Follow these suffixes consistently:

### Request Types
Input data for API endpoints

**Pattern**: `{Action}{Entity}Request`

**Examples**:
- `CreateUserRequest`
- `UpdateProfileRequest`
- `DeletePostRequest`
- `SendMessageRequest`

### Response Types
Output data from API endpoints

**Pattern**: `{Action}{Entity}Response` or `Get{Entity}Response`

**Examples**:
- `GetUserResponse`
- `ListUsersResponse`
- `CreateUserResponse`
- `UpdateProfileResponse`

### Params Types
URL path parameters

**Pattern**: `{Action}{Entity}Params`

**Examples**:
- `GetUserParams`
- `DeletePostParams`
- `UpdateCommentParams`

### Query Types
URL query parameters (filtering, sorting, pagination)

**Pattern**: `{Action}{Entity}Query` or `List{Entity}Request`

**Examples**:
- `SearchUsersQuery`
- `FilterPostsQuery`
- `ListUsersRequest` (includes query params + pagination)

### Body Types
Request body data (when not using Request suffix)

**Pattern**: `{Action}{Entity}Body`

**Examples**:
- `UpdateUserBody`
- `CreatePostBody`

**Note**: Prefer `Request` suffix over `Body` for consistency.

## Anti-Patterns to Avoid

### ❌ Inline Type Definitions

**WRONG** - in backend/src/controllers/userController.ts:
```typescript
interface CreateUserRequest {  // ❌ Should be in shared-types
  username: string;
  email: string;
}

interface CreateUserResponse {  // ❌ Should be in shared-types
  user: User;
  token: string;
}
```

**CORRECT**:
```typescript
import { CreateUserRequest, CreateUserResponse } from '@stewra/shared-types';
```

### ❌ Different Types in Different Services

**WRONG** - backend/src/services/userService.ts:
```typescript
interface UpdateUserData {
  name: string;  // ❌ Different field name
  email: string;
}
```

**WRONG** - frontend/src/services/userService.ts:
```typescript
interface UpdateUserPayload {
  fullName: string;  // ❌ Different field name
  emailAddress: string;  // ❌ Different field name
}
```

**CORRECT** - both use:
```typescript
import { UpdateUserRequest } from '@stewra/shared-types';
```

### ❌ No Type Safety

**WRONG** - using 'any' or no types:
```typescript
async function createUser(data: any): Promise<any> {  // ❌❌❌
  // ...
}
```

**WRONG** - using unknown without validation:
```typescript
const response = await fetch('/api/users');
const user = await response.json();  // ❌ No type safety
```

**CORRECT**:
```typescript
import { User } from '@stewra/shared-types';

const response = await fetch('/api/users');
const user = await response.json() as User;  // ✅ Type-safe
```

### ❌ Inconsistent Field Names

**WRONG** - different field names across services:
```typescript
// Backend returns
{ userId: 1, fullName: 'John' }

// Frontend expects
{ id: 1, name: 'John' }
```

**CORRECT** - shared types ensure consistency:
```typescript
// packages/shared-types/src/models/user.ts
export interface User {
  userId: number;
  fullName: string;
}
```

### ❌ Missing Response Wrappers

**WRONG** - inconsistent response formats:
```typescript
// Some endpoints return
{ user: {...} }

// Others return
{ data: {...} }

// Others return
{ success: true, result: {...} }
```

**CORRECT** - consistent response wrapper:
```typescript
// packages/shared-types/src/api/base.ts
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: ApiError;
}
```

## Best Practices

1. ✅ **Always define API contracts in `packages/shared-types/src/api/`**
   - Never define API types inline in backend, frontend, or website

2. ✅ **Use descriptive, consistent naming**
   - Follow Request/Response suffix pattern
   - Use PascalCase for type names
   - Use descriptive action verbs (Create, Update, Delete, Get, List)

3. ✅ **Import types explicitly**
   ```typescript
   import { CreateUserRequest, UserResponse } from '@stewra/shared-types';
   ```

4. ✅ **Keep shared-types up to date in all services**
   - Rebuild after changes
   - Update version in all consuming services

5. ✅ **Document complex types with JSDoc**
   ```typescript
   /**
    * Request to update user profile information
    * @property userId - The unique identifier of the user
    * @property bio - Optional biography text (max 500 chars)
    */
   export interface UpdateProfileRequest {
     userId: number;
     bio?: string;
   }
   ```

6. ✅ **Use Zod schemas alongside TypeScript types**
   ```typescript
   import { z } from 'zod';

   export const createUserSchema = z.object({
     username: z.string().min(3).max(30),
     email: z.string().email(),
     password: z.string().min(8)
   });

   export type CreateUserRequest = z.infer<typeof createUserSchema>;
   ```

7. ✅ **Test type compatibility across all services**
   ```bash
   cd backend && npm run typecheck
   cd frontend && npm run typecheck
   cd website && npm run typecheck
   ```

8. ✅ **Version shared-types package properly**
   - Use semantic versioning
   - Document breaking changes
   - Update changelog
