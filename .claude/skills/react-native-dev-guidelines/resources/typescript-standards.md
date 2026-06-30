# TypeScript Standards

Complete guide to TypeScript best practices in React Native.

---

## Table of Contents

- [Component Props](#component-props)
- [NO 'any' Type](#no-any-type)
- [Shared Types](#shared-types)
- [Type Utilities](#type-utilities)
- [Best Practices](#best-practices)

---

## Component Props

### Basic Props Interface

```typescript
interface ButtonProps {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}

export const Button: React.FC<ButtonProps> = ({
  title,
  onPress,
  disabled = false,
  variant = 'primary',
}) => {
  return (
    <Pressable onPress={onPress} disabled={disabled}>
      <Text>{title}</Text>
    </Pressable>
  );
};
```

### Props with Children

```typescript
interface CardProps {
  title: string;
  children: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({ title, children }) => (
  <View>
    <Text>{title}</Text>
    {children}
  </View>
);
```

### Props with JSDoc

```typescript
interface UserProfileProps {
  /** User ID to display */
  userId: string;
  /** Show edit button */
  editable?: boolean;
  /** Callback when profile is updated */
  onUpdate?: (userId: string) => void;
}

export const UserProfile: React.FC<UserProfileProps> = ({
  userId,
  editable = false,
  onUpdate,
}) => {
  // Implementation
};
```

---

## NO 'any' Type

### ❌ NEVER Use 'any'

```typescript
// ❌ NEVER
function handleResponse(data: any) {
  return data.result;
}

// ❌ NEVER
const [state, setState] = useState<any>({});

// ❌ NEVER
const fetchData = async (): Promise<any> => {
  // ...
};
```

### ✅ ALWAYS Use Proper Types

```typescript
// ✅ Use specific types
import type { ApiResponse } from '@stewra/shared-types';

function handleResponse<T>(data: ApiResponse<T>): T {
  if (!data.success) {
    throw new Error(data.error);
  }
  return data.data;
}

// ✅ Use interface for state
interface UserState {
  id: string;
  name: string;
  email: string;
}

const [state, setState] = useState<UserState>({
  id: '',
  name: '',
  email: '',
});

// ✅ Use proper return type
interface User {
  id: string;
  name: string;
}

const fetchData = async (): Promise<User> => {
  const response = await fetch('/api/user');
  return response.json();
};
```

### Alternatives to 'any'

```typescript
// Use 'unknown' for truly unknown data
function processData(data: unknown) {
  if (typeof data === 'string') {
    return data.toUpperCase();
  }
  return '';
}

// Use 'object' for object types
function logObject(obj: object) {
  console.log(obj);
}

// Use Record for key-value pairs
function processMap(data: Record<string, unknown>) {
  return Object.keys(data);
}

// Use generic constraints
function getValue<T extends { id: string }>(item: T): string {
  return item.id;
}
```

---

## Shared Types

### Import from @stewra/shared-types

```typescript
import type {
  User,
  ApiResponse,
  PaginatedResponse,
  ErrorResponse,
} from '@stewra/shared-types';

// Use shared types
const fetchUsers = async (): Promise<PaginatedResponse<User>> => {
  const response = await fetch('/api/users');
  return response.json();
};

// Handle errors with shared type
const handleError = (error: ErrorResponse) => {
  console.error(error.message);
};
```

### Define Local Types

```typescript
// types/navigation.ts
import type { StackScreenProps } from '@react-navigation/stack';

export type RootStackParamList = {
  Home: undefined;
  Profile: { userId: string };
  Settings: undefined;
};

export type HomeScreenProps = StackScreenProps<RootStackParamList, 'Home'>;
export type ProfileScreenProps = StackScreenProps<RootStackParamList, 'Profile'>;
```

---

## Type Utilities

### Partial and Required

```typescript
interface User {
  id: string;
  name: string;
  email: string;
  age: number;
}

// Make all properties optional
type PartialUser = Partial<User>;

// Make all properties required
type RequiredUser = Required<User>;
```

### Pick and Omit

```typescript
// Pick specific properties
type UserPreview = Pick<User, 'id' | 'name'>;

// Omit specific properties
type UserWithoutEmail = Omit<User, 'email'>;
```

### Utility Types

```typescript
// Extract keys as union type
type UserKeys = keyof User; // 'id' | 'name' | 'email' | 'age'

// Extract value types
type UserId = User['id']; // string

// NonNullable
type MaybeString = string | null | undefined;
type DefinitelyString = NonNullable<MaybeString>; // string

// ReturnType
function getUser() {
  return { id: '1', name: 'John' };
}
type UserReturnType = ReturnType<typeof getUser>;
```

### Custom Utility Types

```typescript
// Make specific properties optional
type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

interface UserForm {
  name: string;
  email: string;
  age: number;
}

type UserFormWithOptionalAge = Optional<UserForm, 'age'>;

// Make specific properties required
type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;
```

---

## Best Practices

### 1. Type All Function Parameters

```typescript
// ❌ AVOID
const greet = (name) => `Hello, ${name}`;

// ✅ PREFER
const greet = (name: string): string => `Hello, ${name}`;
```

### 2. Type All State

```typescript
// ❌ AVOID
const [user, setUser] = useState(null);

// ✅ PREFER
const [user, setUser] = useState<User | null>(null);
```

### 3. Type All Props

```typescript
// ❌ AVOID
export const Button = ({ title, onPress }) => { /* ... */ };

// ✅ PREFER
interface ButtonProps {
  title: string;
  onPress: () => void;
}

export const Button: React.FC<ButtonProps> = ({ title, onPress }) => { /* ... */ };
```

### 4. Use Const Assertions

```typescript
// Type will be readonly tuple
const colors = ['red', 'green', 'blue'] as const;
type Color = typeof colors[number]; // 'red' | 'green' | 'blue'

// Type will be readonly object
const config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000,
} as const;
```

### 5. Type Guards

```typescript
function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'name' in value
  );
}

// Usage
if (isUser(data)) {
  console.log(data.name); // TypeScript knows this is User
}
```

### 6. Discriminated Unions

```typescript
type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function handleResponse<T>(response: ApiResponse<T>) {
  if (response.success) {
    console.log(response.data); // TypeScript knows data exists
  } else {
    console.error(response.error); // TypeScript knows error exists
  }
}
```

### 7. Generic Components

```typescript
interface ListProps<T> {
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  keyExtractor: (item: T) => string;
}

export function List<T>({ items, renderItem, keyExtractor }: ListProps<T>) {
  return (
    <View>
      {items.map((item) => (
        <View key={keyExtractor(item)}>
          {renderItem(item)}
        </View>
      ))}
    </View>
  );
}

// Usage
<List
  items={users}
  renderItem={(user) => <Text>{user.name}</Text>}
  keyExtractor={(user) => user.id}
/>
```

### 8. Async Function Types

```typescript
// ✅ Proper async function typing
async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  const data = await response.json();
  return data;
}

// ✅ Proper error handling
async function fetchUserSafe(id: string): Promise<User | null> {
  try {
    const response = await fetch(`/api/users/${id}`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Failed to fetch user:', error);
    return null;
  }
}
```

---

## Common Patterns

### API Response Type

```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Usage
const response: ApiResponse<User> = await api.getUser(id);
```

### Pagination Type

```typescript
interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// Usage
const users: PaginatedResponse<User> = await api.getUsers({ page: 1 });
```

### Form State Type

```typescript
interface FormState<T> {
  values: T;
  errors: Partial<Record<keyof T, string>>;
  touched: Partial<Record<keyof T, boolean>>;
  isSubmitting: boolean;
}
```

---

## Key Rules

1. **NO 'any'**: NEVER use 'any' type - always use proper types
2. **Type Everything**: Props, state, function parameters, return values
3. **Shared Types**: Import from @stewra/shared-types when available
4. **Type Guards**: Use type guards for runtime type checking
5. **Generic Types**: Use generics for reusable components
6. **Const Assertions**: Use 'as const' for literal types
7. **Discriminated Unions**: Use for complex type scenarios
8. **JSDoc Comments**: Document complex types and props
