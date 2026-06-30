---
name: website-dev-guidelines
description: Website development guidelines for Vite + React + TypeScript (website/ directory). Modern patterns including CSS Modules, Radix UI, React Router DOM, React Hook Form + Zod, Framer Motion, and performance optimization. Use when working with the web application.
---

# Website Development Guidelines (Vite + React)

## Purpose

Comprehensive guide for Vite web application development (website/ directory), emphasizing modern React patterns, CSS Modules styling, Radix UI components, and performance optimization.

## When to Use This Skill

Automatically activates when working on:
- Creating components or pages in website/
- Building web features
- Styling with CSS Modules
- Using Radix UI components
- Routing with React Router DOM
- Forms with React Hook Form + Zod
- TypeScript best practices for web

---

## Quick Start

### New Component Checklist

- [ ] Use `React.FC<Props>` pattern with TypeScript
- [ ] Create `.module.css` file for styles
- [ ] Use `clsx` for conditional classes
- [ ] Import Radix UI components if needed
- [ ] Use CSS variables from design system
- [ ] Lazy load if heavy component
- [ ] Use `useCallback` for event handlers
- [ ] Export as default
- [ ] No `any` types - use proper TypeScript

### New Page Checklist

- [ ] Create component in `pages/` directory
- [ ] Create corresponding `.module.css` file
- [ ] Add route in `App.tsx` or router config
- [ ] Use React Router DOM hooks (`useNavigate`, `useParams`)
- [ ] Handle loading and error states
- [ ] Use Framer Motion for page transitions

---

## Tech Stack Overview

### Core Framework
- **Vite** - Build tool and dev server
- **React 19** + **TypeScript 5**
- **React Router DOM v7** - Client-side routing

### UI & Styling
- **CSS Modules** - Component-scoped styling
- **CSS Custom Properties** - Theming system
- **PostCSS** - Modern CSS with nesting
- **Radix UI** - Unstyled, accessible components
- **Framer Motion** - Animations
- **Lucide React** - Icon library
- **clsx** - Conditional classnames

### Forms & Validation
- **React Hook Form** - Form state management
- **Zod** - Schema validation

### Other
- **socket.io-client** - Real-time communication
- **@isshe10/design-system** - Custom design system
- **@stewra/shared-types** - Shared TypeScript types

---

## Core Principles (8 Key Rules)

### 1. CSS Modules for All Styling

```typescript
// Component.tsx
import styles from './Component.module.css';
import clsx from 'clsx';

export const Component: React.FC<Props> = ({ variant, className }) => (
  <div className={clsx(styles.container, styles[variant], className)}>
    {/* Content */}
  </div>
);
```

See [styling-guide.md](resources/styling-guide.md) for complete patterns.

### 2. Use CSS Variables from Design System

```css
.container {
  background: hsl(var(--background));
  color: hsl(var(--foreground));
  padding: var(--spacing-4);
  border-radius: var(--radius);
}
```

### 3. Radix UI for Complex Components

```typescript
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
```

See [component-patterns.md](resources/component-patterns.md) for examples.

### 4. Type-Safe Routing

```typescript
import { useNavigate, useParams } from 'react-router-dom';
```

See [routing-guide.md](resources/routing-guide.md) for navigation patterns.

### 5. React Hook Form + Zod Validation

```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const schema = z.object({ email: z.string().email() });
```

See [data-fetching.md](resources/data-fetching.md) for form patterns.

### 6. NO 'any' Type - EVER

```typescript
// ❌ NEVER
function handleData(data: any) { }

// ✅ ALWAYS
interface Data { value: string; }
function handleData(data: Data) { }
```

See [typescript-standards.md](resources/typescript-standards.md) for details.

### 7. Code Splitting & Lazy Loading

```typescript
import { lazy, Suspense } from 'react';

const Dashboard = lazy(() => import('./pages/Dashboard'));
```

See [performance.md](resources/performance.md) for optimization strategies.

### 8. API Contracts MUST Use @stewra/shared-types

**CRITICAL:** All API calls to backend MUST use shared types from `@stewra/shared-types` for type safety.

```typescript
// ❌ NEVER: Define API types inline
interface User { id: string; name: string; }
const response = await fetch('/api/users');
const user: User = await response.json();

// ✅ ALWAYS: Use shared types for ALL API interactions
import type { UserResponse, CreateUserRequest, ApiResponse } from '@stewra/shared-types';

const createUser = async (data: CreateUserRequest): Promise<ApiResponse<UserResponse>> => {
  const response = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return response.json();
};
```

**Why:** Ensures type safety across website and backend. Any API change immediately shows type errors.

**Applies to:**
- All API request bodies
- All API response types
- WebSocket message types
- All data received from or sent to backend

---

## Common Imports

```typescript
// React & Core
import React, { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';

// Routing
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

// Forms
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

// Animations
import { motion } from 'framer-motion';

// Icons
import { User, Settings, LogOut } from 'lucide-react';

// Utilities
import clsx from 'clsx';

// Radix UI
import * as Avatar from '@radix-ui/react-avatar';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Select from '@radix-ui/react-select';

// Shared Types
import type { User, ApiResponse } from '@stewra/shared-types';
```

---

## File Organization

```
website/src/
  components/          # Reusable UI components
    Card/
      Card.tsx
      Card.module.css
    Button/
      Button.tsx
      Button.module.css

  pages/              # Page components
    HomePage.tsx
    HomePage.module.css
    dashboard/
      ProfilePage.tsx
      ProfilePage.module.css

  styles/             # Global styles
    globals.css
    designSystemVariables.css
    tokens.css
    animations.css

  hooks/              # Custom React hooks
    useAuth.ts
    useSocket.ts

  utils/              # Utility functions
    api.ts
    formatters.ts

  types/              # TypeScript types
    index.ts
```

See [file-organization.md](resources/file-organization.md) for detailed structure.

---

## Anti-Patterns to Avoid

❌ Using `any` type anywhere
❌ Inline styles instead of CSS Modules
❌ Hardcoded colors (use CSS variables)
❌ Missing loading/error states
❌ Not lazy loading heavy components
❌ Direct style manipulation
❌ Missing form validation
❌ console.log in production

---

## Navigation Guide

| Need to... | Read this |
|------------|-----------|
| Style components with CSS Modules | [styling-guide.md](resources/styling-guide.md) |
| Use Radix UI components | [component-patterns.md](resources/component-patterns.md) |
| Setup routing and navigation | [routing-guide.md](resources/routing-guide.md) |
| Create forms with validation | [data-fetching.md](resources/data-fetching.md) |
| Handle loading and errors | [loading-and-error-states.md](resources/loading-and-error-states.md) |
| Optimize performance | [performance.md](resources/performance.md) |
| TypeScript best practices | [typescript-standards.md](resources/typescript-standards.md) |
| Common patterns and examples | [common-patterns.md](resources/common-patterns.md) |
| Complete code examples | [complete-examples.md](resources/complete-examples.md) |
| File organization | [file-organization.md](resources/file-organization.md) |

---

## Resource Files

### [styling-guide.md](resources/styling-guide.md)
CSS Modules patterns, CSS variables, clsx usage, responsive design

### [component-patterns.md](resources/component-patterns.md)
Radix UI examples, reusable components, composition patterns

### [routing-guide.md](resources/routing-guide.md)
React Router DOM setup, navigation, protected routes, hooks

### [data-fetching.md](resources/data-fetching.md)
React Hook Form, Zod validation, API calls, custom hooks

### [loading-and-error-states.md](resources/loading-and-error-states.md)
Loading patterns, error boundaries, suspense usage

### [performance.md](resources/performance.md)
Code splitting, memoization, lazy loading, optimization

### [typescript-standards.md](resources/typescript-standards.md)
NO 'any' rule, proper typing, interfaces, generics

### [common-patterns.md](resources/common-patterns.md)
Framer Motion animations, Lucide icons, common utilities

### [complete-examples.md](resources/complete-examples.md)
Full component examples, page templates, real-world patterns

### [file-organization.md](resources/file-organization.md)
Project structure, naming conventions, import patterns

---

## Quick Reference

### Component Template

```typescript
import React from 'react';
import styles from './Component.module.css';
import clsx from 'clsx';

interface ComponentProps {
  title: string;
  variant?: 'default' | 'highlighted';
  className?: string;
}

export const Component: React.FC<ComponentProps> = ({
  title,
  variant = 'default',
  className
}) => {
  return (
    <div className={clsx(styles.container, styles[variant], className)}>
      <h2 className={styles.title}>{title}</h2>
    </div>
  );
};

export default Component;
```

### Page Template

```typescript
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './Page.module.css';

export const Page: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch data
  }, []);

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div className={styles.container}>
      {/* Content */}
    </div>
  );
};

export default Page;
```

---

## Related Skills

- **react-native-dev-guidelines** - Mobile app patterns (frontend/ directory)
- **backend-dev-guidelines** - Backend API patterns
- **error-tracking** - Error tracking with Sentry

---

**Skill Status**: COMPLETE ✅
**Line Count**: < 400 ✅
**Progressive Disclosure**: 10 resource files ✅
