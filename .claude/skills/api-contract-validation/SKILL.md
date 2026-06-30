---
name: api-contract-validation
description: Enforce consistent API contract usage with shared-types across backend, frontend, and website. Use when creating API endpoints, controllers, services, routes, or any API-related code. Ensures request/response types are defined in @stewra/shared-types package and used consistently across all three services.
---

# API Contract Validation

## Purpose

Enforce consistent API contract definitions using shared-types across backend, frontend, and website services. This skill ensures:
- All API contracts are defined in the `@stewra/shared-types` package
- Backend, frontend, and website use the same type definitions
- No inline API type definitions in service code
- Proper naming conventions for API contracts
- Type safety across the entire application

## When to Use This Skill

Automatically activates when working on:
- Backend controllers (`backend/src/controllers/`)
- Backend routes (`backend/src/routes/`)
- Backend services (`backend/src/services/`)
- Frontend services (`frontend/src/services/`)
- Website services (`website/src/services/`)
- Website API routes (`website/src/app/api/`, `website/src/pages/api/`)
- Shared types API contracts (`packages/shared-types/src/api/`)

---

## Quick Start

### New API Endpoint Checklist

- [ ] **Define types** in `packages/shared-types/src/api/{domain}.ts`
- [ ] **Rebuild** shared-types: `cd packages/shared-types && npm run build`
- [ ] **Backend controller**: Import and use shared types
- [ ] **Backend service**: Use shared types for parameters/returns
- [ ] **Frontend service**: Use shared types for API calls
- [ ] **Website service** (if needed): Use shared types
- [ ] **Type check all**: Verify in backend, frontend, website
- [ ] **Test integration**: End-to-end type safety

### Modifying Existing API Checklist

- [ ] **Update types** in shared-types package
- [ ] **Consider** backward compatibility
- [ ] **Rebuild** shared-types
- [ ] **Update all consumers**: backend, frontend, website
- [ ] **Run tests** in all services
- [ ] **Type check** all services

---

## Core Principles (4 Key Rules)

### 1. API Contracts MUST Use @stewra/shared-types

**CRITICAL:** All API contracts between services MUST use shared types.

```typescript
// ❌ NEVER: Define API types inline
interface CreateUserRequest { username: string; }

// ✅ ALWAYS: Use shared types
import { CreateUserRequest, CreateUserResponse } from '@stewra/shared-types';
```

**Why:** Ensures type safety across the entire stack. Frontend, mobile, and backend all use the same definitions, preventing runtime errors.

### 2. Single Source of Truth

All API contract definitions live in ONE place:
```
packages/shared-types/src/api/
```

Never duplicate type definitions across services.

### 3. Consistent Naming

Follow strict naming conventions:
- `Create{Entity}Request` / `Create{Entity}Response`
- `Update{Entity}Request` / `Update{Entity}Response`
- `Get{Entity}Request` / `Get{Entity}Response`
- `List{Entity}Request` / `List{Entity}Response`
- `Delete{Entity}Request` / `Delete{Entity}Response`

See [naming-conventions.md](resources/naming-conventions.md) for complete guide.

### 4. Type Check Everything

Run type checking in all services:
```bash
cd backend && npm run typecheck
cd frontend && npm run typecheck
cd website && npm run typecheck
```

---

## Shared Types Package Structure

**Location**: `packages/shared-types/`

```
packages/shared-types/
├── src/
│   ├── api/           # API contract definitions (Request/Response types)
│   │   ├── auth.ts
│   │   ├── user.ts
│   │   ├── chat.ts
│   │   ├── payment.ts
│   │   ├── base.ts    # Common types (ApiResponse, Pagination)
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

See [shared-types-integration.md](resources/shared-types-integration.md) for details.

---

## Quick Reference

### Backend Usage

```typescript
import {
  CreateUserRequest,
  CreateUserResponse
} from '@stewra/shared-types';

export class UserController extends BaseController {
  async createUser(req: Request, res: Response): Promise<void> {
    const data: CreateUserRequest = req.body;
    const result = await userService.createUser(data);
    const response: CreateUserResponse = result;
    this.sendSuccess(res, response, 'User created', 201);
  }
}
```

See [backend-usage.md](resources/backend-usage.md) for complete patterns.

### Frontend Usage

```typescript
import {
  CreateUserRequest,
  CreateUserResponse
} from '@stewra/shared-types';

export class UserService {
  async createUser(data: CreateUserRequest): Promise<CreateUserResponse> {
    const response = await apiClient.post<CreateUserResponse>('/users', data);
    return response.data;
  }
}
```

See [frontend-usage.md](resources/frontend-usage.md) for complete patterns.

### Website Usage

```typescript
import {
  GetUserResponse,
  User
} from '@stewra/shared-types';

export class UserService {
  async getUser(userId: number): Promise<User> {
    const response = await fetchApi<GetUserResponse>(`/api/users/${userId}`);
    return response.user;
  }
}
```

See [frontend-usage.md](resources/frontend-usage.md) for complete patterns.

---

## Common Imports

```typescript
// Shared Types (REQUIRED for API contracts)
import type {
  CreateUserRequest,
  CreateUserResponse,
  UpdateUserRequest,
  GetUserResponse,
  ListUsersRequest,
  ListUsersResponse,
  User,
  ApiResponse,
  PaginationParams
} from '@stewra/shared-types';

// Backend - Express
import { Request, Response } from 'express';

// Frontend - React Native
import { apiClient } from '@/utils/apiClient';

// Website - Next.js
import { fetchApi } from '@/utils/fetch';
```

---

## Anti-Patterns to Avoid

❌ Inline type definitions in controllers/services
❌ Different field names across services
❌ Using 'any' type for API data
❌ No type assertions on API responses
❌ Inconsistent naming conventions
❌ Missing shared-types imports

See [naming-conventions.md](resources/naming-conventions.md) for complete list.

---

## Navigation Guide

| Need to... | Read this |
|------------|-----------|
| Understand shared-types structure | [shared-types-integration.md](resources/shared-types-integration.md) |
| Implement backend API contracts | [backend-usage.md](resources/backend-usage.md) |
| Implement frontend API calls | [frontend-usage.md](resources/frontend-usage.md) |
| Follow naming conventions | [naming-conventions.md](resources/naming-conventions.md) |
| Add/modify API endpoints | [workflow-troubleshooting.md](resources/workflow-troubleshooting.md) |
| Fix type errors | [workflow-troubleshooting.md](resources/workflow-troubleshooting.md) |

---

## Resource Files

### [shared-types-integration.md](resources/shared-types-integration.md)
Project architecture, shared-types package structure, API contract patterns, CRUD template

### [backend-usage.md](resources/backend-usage.md)
Backend controllers, services, request/response handling, validation patterns

### [frontend-usage.md](resources/frontend-usage.md)
Frontend services, React components, Website services, Next.js patterns

### [naming-conventions.md](resources/naming-conventions.md)
Type naming conventions, anti-patterns, best practices, examples

### [workflow-troubleshooting.md](resources/workflow-troubleshooting.md)
Adding endpoints, modifying APIs, troubleshooting type errors, validation behavior

---

## Workflow Summary

### Adding New API Endpoint

1. **Define types** in `packages/shared-types/src/api/{domain}.ts`
2. **Rebuild** shared-types package
3. **Implement backend** (controller → service → route)
4. **Implement frontend** (service → component)
5. **Implement website** (if needed)
6. **Verify consistency** (type check all services)

See [workflow-troubleshooting.md](resources/workflow-troubleshooting.md) for detailed steps.

### Modifying Existing API

1. **Update types** in shared-types
2. **Consider** backward compatibility
3. **Rebuild** package
4. **Update all consumers**
5. **Test** across all services

See [workflow-troubleshooting.md](resources/workflow-troubleshooting.md) for detailed steps.

---

## Hook Validation

The `api-contract-validator` hook will:

**Block if:**
- API types defined inline instead of shared-types
- Types not found in shared-types package
- Missing shared-types import in API files

**Warn if:**
- Inconsistent naming conventions
- API calls without type safety
- Missing documentation

**Skip validation:**
```bash
export SKIP_API_CONTRACT_VALIDATION=true
```

See [workflow-troubleshooting.md](resources/workflow-troubleshooting.md) for validation details.

---

## Troubleshooting Quick Reference

| Issue | Solution |
|-------|----------|
| Type not found | Rebuild shared-types, reinstall in services |
| Import errors | Restart TS server, verify node_modules |
| Type mismatch | Ensure same version across all services |
| Changes not reflecting | Clean build, force reinstall |

See [workflow-troubleshooting.md](resources/workflow-troubleshooting.md) for detailed solutions.

---

## Best Practices

1. ✅ Always define API contracts in `packages/shared-types/src/api/`
2. ✅ Use descriptive, consistent naming (Request/Response suffixes)
3. ✅ Import types explicitly: `import { Type } from '@stewra/shared-types'`
4. ✅ Keep shared-types up to date in all services
5. ✅ Document complex types with JSDoc comments
6. ✅ Use Zod schemas alongside TypeScript types for runtime validation
7. ✅ Test type compatibility across all services
8. ✅ Version shared-types package properly

---

## Related Skills

- **backend-dev-guidelines** - Backend development patterns
- **frontend-dev-guidelines** - Frontend development patterns (removed, use react-native or website)
- **react-native-dev-guidelines** - Mobile app patterns
- **website-dev-guidelines** - Web app patterns

---

**Skill Status**: COMPLETE ✅
**Line Count**: 350 lines (< 400) ✅
**Progressive Disclosure**: 4 resource files ✅
