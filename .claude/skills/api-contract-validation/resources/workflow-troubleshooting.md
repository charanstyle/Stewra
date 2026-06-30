# Workflow & Troubleshooting

## Adding New API Endpoint

Follow these steps when creating a new API endpoint:

### 1. Define Types in Shared-Types

```bash
cd packages/shared-types
# Edit src/api/{domain}.ts
```

**Example**: Add new endpoint types
```typescript
// packages/shared-types/src/api/post.ts
export interface CreatePostRequest {
  title: string;
  content: string;
  tags?: string[];
}

export interface CreatePostResponse {
  post: Post;
  message: string;
}
```

### 2. Rebuild Shared-Types

```bash
npm run build
```

This compiles TypeScript and makes types available to consumers.

### 3. Implement Backend

**Controller** - Handle HTTP requests:
```typescript
// backend/src/controllers/postController.ts
import { CreatePostRequest, CreatePostResponse } from '@stewra/shared-types';

export class PostController extends BaseController {
  async createPost(req: Request, res: Response): Promise<void> {
    const data: CreatePostRequest = req.body;
    const result = await postService.createPost(data);
    const response: CreatePostResponse = result;
    this.sendSuccess(res, response, 'Post created', 201);
  }
}
```

**Service** - Business logic:
```typescript
// backend/src/services/postService.ts
import { CreatePostRequest, CreatePostResponse } from '@stewra/shared-types';

export class PostService {
  async createPost(data: CreatePostRequest): Promise<CreatePostResponse> {
    const post = await prisma.post.create({ data });
    return { post: this.mapToPost(post), message: 'Success' };
  }
}
```

**Route** - Register endpoint:
```typescript
// backend/src/routes/postRoutes.ts
router.post('/posts', (req, res) => postController.createPost(req, res));
```

### 4. Implement Frontend

**Service** - API calls:
```typescript
// frontend/src/services/post/postService.ts
import { CreatePostRequest, CreatePostResponse } from '@stewra/shared-types';

export class PostService {
  async createPost(data: CreatePostRequest): Promise<CreatePostResponse> {
    const response = await apiClient.post<CreatePostResponse>('/posts', data);
    return response.data;
  }
}
```

**Component** - Use in UI:
```typescript
import { CreatePostRequest } from '@stewra/shared-types';

const handleSubmit = async (formData: CreatePostRequest) => {
  const result = await postService.createPost(formData);
  console.log('Created post:', result.post);
};
```

### 5. Implement Website (if needed)

Similar to frontend, but with Next.js patterns.

### 6. Verify Consistency

Run type checking in all projects:

```bash
# Backend
cd backend && npm run typecheck

# Frontend
cd frontend && npm run typecheck

# Website
cd website && npm run typecheck
```

All should pass without errors.

## Modifying Existing API

### 1. Update Shared-Types

Modify types in `packages/shared-types/src/api/`

**Consider backward compatibility:**
- Adding optional fields: ✅ Safe
- Removing fields: ❌ Breaking change
- Changing field types: ❌ Breaking change
- Renaming fields: ❌ Breaking change

**Example**: Add optional field (safe)
```typescript
export interface UpdateUserRequest {
  userId: number;
  firstName?: string;
  lastName?: string;
  bio?: string;  // ✅ New optional field - backward compatible
}
```

### 2. Rebuild Package

```bash
cd packages/shared-types && npm run build
```

### 3. Update All Consumers

Update code in:
- Backend controller/service
- Frontend service
- Website service

### 4. Test Across All Services

Run tests to ensure nothing broke:
```bash
cd backend && npm test
cd frontend && npm test
cd website && npm test
```

## Hook Validation Behavior

The `api-contract-validator` hook will:

### Block Conditions

Hook will **BLOCK** if it detects:

1. **API types defined inline** instead of shared-types
   ```typescript
   // ❌ Will block
   interface CreateUserRequest { ... }
   ```

2. **Types not found in shared-types package**
   ```typescript
   // ❌ Will block - type doesn't exist in shared-types
   import { NonExistentType } from '@stewra/shared-types';
   ```

3. **Missing shared-types import in API files**
   ```typescript
   // ❌ Will block - no shared-types import in API controller
   router.post('/users', (req, res) => { ... });
   ```

### Warning Conditions

Hook will **WARN** if it detects:

1. **Inconsistent naming conventions**
   - Not using Request/Response suffixes
   - Inconsistent naming patterns

2. **API calls without type safety**
   ```typescript
   // ⚠️ Will warn
   const response = await fetch('/api/users');
   const data = await response.json();  // No type assertion
   ```

3. **Missing documentation**
   - Complex types without JSDoc comments

### Skip Validation

To bypass validation (use sparingly):

**Environment variable**:
```bash
export SKIP_API_CONTRACT_VALIDATION=true
```

**File marker**:
```typescript
// @skip-validation
// This file has been manually verified for API contract consistency
```

## Troubleshooting

### Issue: Type not found after adding to shared-types

**Symptoms**:
```
Cannot find name 'CreateUserRequest'
```

**Solution**:
```bash
# 1. Rebuild shared-types
cd packages/shared-types
npm run build

# 2. Reinstall in consuming services
cd ../../backend && npm install
cd ../frontend && npm install
cd ../website && npm install

# 3. Restart TypeScript server in IDE
# VS Code: Cmd+Shift+P -> "TypeScript: Restart TS Server"
```

### Issue: Import errors in IDE

**Symptoms**:
- Red squiggly lines under imports
- "Module not found" errors

**Solution**:
1. **Restart TypeScript server**
   - VS Code: Cmd+Shift+P -> "TypeScript: Restart TS Server"

2. **Verify package exists**
   ```bash
   ls node_modules/@stewra/shared-types
   ```

3. **Check tsconfig.json paths**
   ```json
   {
     "compilerOptions": {
       "paths": {
         "@stewra/shared-types": ["node_modules/@stewra/shared-types"]
       }
     }
   }
   ```

4. **Clear node_modules and reinstall**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

### Issue: Type mismatch between services

**Symptoms**:
```
Type 'User' is not assignable to type 'User'
```

**Solution**:
1. **Verify all services use same shared-types version**
   ```bash
   # Check version in each service
   grep "@stewra/shared-types" backend/package.json
   grep "@stewra/shared-types" frontend/package.json
   grep "@stewra/shared-types" website/package.json
   ```

2. **Update to same version**
   ```bash
   cd backend && npm install @stewra/shared-types@latest
   cd ../frontend && npm install @stewra/shared-types@latest
   cd ../website && npm install @stewra/shared-types@latest
   ```

3. **Rebuild shared-types**
   ```bash
   cd packages/shared-types
   npm run build
   ```

4. **Reinstall in all services**
   ```bash
   cd ../../backend && npm install
   cd ../frontend && npm install
   cd ../website && npm install
   ```

### Issue: Changes not reflecting

**Symptoms**:
- Updated types but old types still showing
- Build succeeds but runtime fails

**Solution**:
```bash
# 1. Clean build artifacts
cd packages/shared-types
rm -rf dist
npm run build

# 2. Force reinstall in all services
cd ../backend
rm -rf node_modules/@stewra/shared-types
npm install

cd ../frontend
rm -rf node_modules/@stewra/shared-types
npm install

cd ../website
rm -rf node_modules/@stewra/shared-types
npm install

# 3. Restart dev servers
```

### Issue: Circular dependencies

**Symptoms**:
```
Circular dependency detected
```

**Solution**:
1. **Review import structure** - shared-types should not import from backend/frontend/website
2. **Keep shared-types independent** - only domain models and API contracts
3. **Use type-only imports** when possible:
   ```typescript
   import type { User } from '@stewra/shared-types';
   ```
