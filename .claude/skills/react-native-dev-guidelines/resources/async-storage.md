# AsyncStorage

Complete guide to persistent local storage using AsyncStorage in React Native.

---

## Table of Contents

- [Basic Operations](#basic-operations)
- [Storing Objects](#storing-objects)
- [Custom Hooks](#custom-hooks)
- [Best Practices](#best-practices)

---

## Basic Operations

### Store String Data

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';

export const storeData = async (key: string, value: string) => {
  try {
    await AsyncStorage.setItem(key, value);
    console.log('Data stored successfully');
  } catch (error) {
    console.error('Error storing data:', error);
  }
};

// Usage
await storeData('username', 'john_doe');
```

### Get String Data

```typescript
export const getData = async (key: string): Promise<string | null> => {
  try {
    const value = await AsyncStorage.getItem(key);
    return value;
  } catch (error) {
    console.error('Error getting data:', error);
    return null;
  }
};

// Usage
const username = await getData('username');
```

### Remove Data

```typescript
export const removeData = async (key: string) => {
  try {
    await AsyncStorage.removeItem(key);
    console.log('Data removed successfully');
  } catch (error) {
    console.error('Error removing data:', error);
  }
};

// Usage
await removeData('username');
```

### Clear All Data

```typescript
export const clearAll = async () => {
  try {
    await AsyncStorage.clear();
    console.log('All data cleared');
  } catch (error) {
    console.error('Error clearing data:', error);
  }
};
```

---

## Storing Objects

### Store Object

```typescript
export const storeObject = async <T,>(key: string, value: T) => {
  try {
    const jsonValue = JSON.stringify(value);
    await AsyncStorage.setItem(key, jsonValue);
  } catch (error) {
    console.error('Error storing object:', error);
  }
};

// Usage
interface User {
  id: string;
  name: string;
  email: string;
}

const user: User = {
  id: '123',
  name: 'John Doe',
  email: 'john@example.com',
};

await storeObject('user', user);
```

### Get Object

```typescript
export const getObject = async <T,>(key: string): Promise<T | null> => {
  try {
    const jsonValue = await AsyncStorage.getItem(key);
    return jsonValue != null ? JSON.parse(jsonValue) : null;
  } catch (error) {
    console.error('Error getting object:', error);
    return null;
  }
};

// Usage
const user = await getObject<User>('user');
if (user) {
  console.log(user.name);
}
```

### Update Object

```typescript
export const updateObject = async <T,>(
  key: string,
  updates: Partial<T>
): Promise<T | null> => {
  try {
    const existing = await getObject<T>(key);
    if (!existing) return null;

    const updated = { ...existing, ...updates };
    await storeObject(key, updated);
    return updated;
  } catch (error) {
    console.error('Error updating object:', error);
    return null;
  }
};

// Usage
await updateObject<User>('user', { name: 'Jane Doe' });
```

---

## Custom Hooks

### useAsyncStorage Hook

```typescript
import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export function useAsyncStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T) => Promise<void>, boolean] {
  const [storedValue, setStoredValue] = useState<T>(initialValue);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStoredValue();
  }, [key]);

  const loadStoredValue = async () => {
    try {
      const item = await AsyncStorage.getItem(key);
      const value = item ? JSON.parse(item) : initialValue;
      setStoredValue(value);
    } catch (error) {
      console.error('Error loading stored value:', error);
      setStoredValue(initialValue);
    } finally {
      setLoading(false);
    }
  };

  const setValue = useCallback(
    async (value: T) => {
      try {
        setStoredValue(value);
        await AsyncStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        console.error('Error setting value:', error);
      }
    },
    [key]
  );

  return [storedValue, setValue, loading];
}

// Usage
const [user, setUser, loading] = useAsyncStorage<User>('user', {
  id: '',
  name: '',
  email: '',
});

if (loading) {
  return <Loading />;
}

return <Text>{user.name}</Text>;
```

### usePersistedState Hook

```typescript
export function usePersistedState<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(initialValue);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load initial value
  useEffect(() => {
    const loadValue = async () => {
      try {
        const item = await AsyncStorage.getItem(key);
        if (item !== null) {
          setState(JSON.parse(item));
        }
      } catch (error) {
        console.error('Error loading persisted state:', error);
      } finally {
        setIsLoaded(true);
      }
    };

    loadValue();
  }, [key]);

  // Save on change
  useEffect(() => {
    if (isLoaded) {
      AsyncStorage.setItem(key, JSON.stringify(state));
    }
  }, [key, state, isLoaded]);

  return [state, setState];
}

// Usage
const [isDarkMode, setIsDarkMode] = usePersistedState('darkMode', false);
```

---

## Best Practices

### Storage Manager

Create a centralized storage manager:

```typescript
// storage.ts
import AsyncStorage from '@react-native-async-storage/async-storage';

export const STORAGE_KEYS = {
  USER: 'user',
  AUTH_TOKEN: 'auth_token',
  SETTINGS: 'settings',
  THEME: 'theme',
} as const;

class StorageManager {
  async set<T>(key: string, value: T): Promise<void> {
    try {
      const jsonValue = JSON.stringify(value);
      await AsyncStorage.setItem(key, jsonValue);
    } catch (error) {
      console.error(`Error storing ${key}:`, error);
      throw error;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const jsonValue = await AsyncStorage.getItem(key);
      return jsonValue != null ? JSON.parse(jsonValue) : null;
    } catch (error) {
      console.error(`Error getting ${key}:`, error);
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(key);
    } catch (error) {
      console.error(`Error removing ${key}:`, error);
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await AsyncStorage.clear();
    } catch (error) {
      console.error('Error clearing storage:', error);
      throw error;
    }
  }

  async getMultiple(keys: string[]): Promise<Record<string, unknown>> {
    try {
      const values = await AsyncStorage.multiGet(keys);
      return values.reduce((acc, [key, value]) => {
        acc[key] = value ? JSON.parse(value) : null;
        return acc;
      }, {} as Record<string, unknown>);
    } catch (error) {
      console.error('Error getting multiple:', error);
      return {};
    }
  }
}

export const storage = new StorageManager();

// Usage
import { storage, STORAGE_KEYS } from './storage';

await storage.set(STORAGE_KEYS.USER, user);
const user = await storage.get<User>(STORAGE_KEYS.USER);
```

### Type-Safe Storage

```typescript
interface StorageSchema {
  user: User;
  authToken: string;
  settings: AppSettings;
  theme: 'light' | 'dark';
}

class TypedStorage {
  async set<K extends keyof StorageSchema>(
    key: K,
    value: StorageSchema[K]
  ): Promise<void> {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  }

  async get<K extends keyof StorageSchema>(
    key: K
  ): Promise<StorageSchema[K] | null> {
    const value = await AsyncStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  }
}

export const typedStorage = new TypedStorage();

// Type-safe usage
await typedStorage.set('user', { id: '1', name: 'John' }); // ✅ Type-safe
await typedStorage.set('user', 'invalid'); // ❌ TypeScript error
```

### Error Handling

```typescript
export async function safeStorageOperation<T>(
  operation: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    console.error('Storage operation failed:', error);
    return fallback;
  }
}

// Usage
const user = await safeStorageOperation(
  () => storage.get<User>(STORAGE_KEYS.USER),
  null
);
```

### Migration Helper

```typescript
export async function migrateStorageKey(
  oldKey: string,
  newKey: string
): Promise<void> {
  try {
    const value = await AsyncStorage.getItem(oldKey);
    if (value !== null) {
      await AsyncStorage.setItem(newKey, value);
      await AsyncStorage.removeItem(oldKey);
      console.log(`Migrated ${oldKey} to ${newKey}`);
    }
  } catch (error) {
    console.error('Migration failed:', error);
  }
}
```

---

## Common Patterns

### Authentication Token Storage

```typescript
export const authStorage = {
  async setToken(token: string): Promise<void> {
    await storage.set(STORAGE_KEYS.AUTH_TOKEN, token);
  },

  async getToken(): Promise<string | null> {
    return await storage.get<string>(STORAGE_KEYS.AUTH_TOKEN);
  },

  async removeToken(): Promise<void> {
    await storage.remove(STORAGE_KEYS.AUTH_TOKEN);
  },

  async isAuthenticated(): Promise<boolean> {
    const token = await this.getToken();
    return token !== null;
  },
};
```

### Settings Storage

```typescript
interface AppSettings {
  notifications: boolean;
  darkMode: boolean;
  language: string;
}

export const settingsStorage = {
  async getSettings(): Promise<AppSettings> {
    const settings = await storage.get<AppSettings>(STORAGE_KEYS.SETTINGS);
    return settings || {
      notifications: true,
      darkMode: false,
      language: 'en',
    };
  },

  async updateSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.getSettings();
    const updated = { ...current, ...updates };
    await storage.set(STORAGE_KEYS.SETTINGS, updated);
    return updated;
  },
};
```

---

## Performance Tips

1. **Batch Operations**: Use `multiGet` and `multiSet` for multiple keys
2. **Avoid Frequent Writes**: Debounce or batch storage writes
3. **Size Limits**: Keep stored data under 2MB for optimal performance
4. **JSON Parse**: Cache parsed objects when accessed frequently
5. **Keys**: Use consistent, prefixed keys to avoid collisions
6. **Clear Strategy**: Don't clear all data unless necessary
7. **Error Recovery**: Always provide fallback values
