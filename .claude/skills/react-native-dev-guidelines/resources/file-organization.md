# File Organization

Complete guide to organizing React Native project structure.

---

## Directory Structure

```
frontend/src/
  screens/           # Screen components
    auth/
      LoginScreen.tsx
      RegisterScreen.tsx
      ForgotPasswordScreen.tsx
    home/
      HomeScreen.tsx
      FeedScreen.tsx
    profile/
      ProfileScreen.tsx
      EditProfileScreen.tsx
    settings/
      SettingsScreen.tsx

  components/        # Reusable components
    common/          # Generic reusable components
      Button/
        Button.tsx
        Button.styles.ts
      Card/
        Card.tsx
      Input/
        Input.tsx
    layout/          # Layout components
      Header.tsx
      Footer.tsx
      Container.tsx
    specific/        # Feature-specific components
      UserCard.tsx
      PostList.tsx

  navigation/        # Navigation configuration
    AppNavigator.tsx
    AuthNavigator.tsx
    MainNavigator.tsx
    types.ts

  hooks/             # Custom React hooks
    useAuth.ts
    useSocket.ts
    useDebounce.ts
    useAsyncStorage.ts

  utils/             # Utility functions
    api.ts
    storage.ts
    validation.ts
    formatting.ts

  services/          # External service integrations
    authService.ts
    apiService.ts
    analyticsService.ts

  types/             # TypeScript types
    index.ts
    api.ts
    models.ts

  contexts/          # React Context
    AuthContext.tsx
    ThemeContext.tsx
    UserContext.tsx

  constants/         # App constants
    colors.ts
    sizes.ts
    endpoints.ts

  assets/            # Static assets
    images/
    fonts/
    icons/

  config/            # Configuration files
    env.ts
    firebase.ts
```

---

## File Naming Conventions

### Components

```typescript
// PascalCase for components
Button.tsx
UserCard.tsx
ProfileHeader.tsx

// Accompanying style files
Button.styles.ts
UserCard.styles.ts
```

### Screens

```typescript
// PascalCase with 'Screen' suffix
LoginScreen.tsx
HomeScreen.tsx
ProfileScreen.tsx
```

### Hooks

```typescript
// camelCase with 'use' prefix
useAuth.ts
useDebounce.ts
useAsyncStorage.ts
```

### Utilities

```typescript
// camelCase for utility files
api.ts
storage.ts
validation.ts
formatting.ts
```

### Types

```typescript
// camelCase or PascalCase
types.ts
apiTypes.ts
models.ts
```

---

## Component Organization

### Single File Component

```typescript
// Button.tsx
import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
}

export const Button: React.FC<ButtonProps> = ({
  title,
  onPress,
  variant = 'primary',
}) => (
  <Pressable onPress={onPress} style={[styles.button, styles[variant]]}>
    <Text style={styles.text}>{title}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  button: {
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  primary: {
    backgroundColor: '#6366f1',
  },
  secondary: {
    backgroundColor: '#e5e7eb',
  },
  text: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
});

export default Button;
```

### Component with Separate Styles

```typescript
// Button.tsx
import React from 'react';
import { Pressable, Text } from 'react-native';
import { styles } from './Button.styles';

interface ButtonProps {
  title: string;
  onPress: () => void;
}

export const Button: React.FC<ButtonProps> = ({ title, onPress }) => (
  <Pressable onPress={onPress} style={styles.button}>
    <Text style={styles.text}>{title}</Text>
  </Pressable>
);

export default Button;

// Button.styles.ts
import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  button: {
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#6366f1',
  },
  text: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
});
```

---

## Screen Organization

### Basic Screen Structure

```typescript
// HomeScreen.tsx
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  SafeAreaView,
  StyleSheet,
} from 'react-native';
import type { HomeScreenProps } from '../navigation/types';

export const HomeScreen: React.FC<HomeScreenProps> = ({ navigation, route }) => {
  // State
  const [data, setData] = useState<Data[]>([]);
  const [loading, setLoading] = useState(true);

  // Effects
  useEffect(() => {
    fetchData();
  }, []);

  // Handlers
  const fetchData = async () => {
    try {
      const result = await api.getData();
      setData(result);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handlePress = () => {
    navigation.navigate('Details');
  };

  // Render
  if (loading) {
    return <LoadingScreen />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Home</Text>
        {/* Content */}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  content: {
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
});

export default HomeScreen;
```

---

## Index Exports

### Barrel Exports

```typescript
// components/common/index.ts
export { Button } from './Button/Button';
export { Card } from './Card/Card';
export { Input } from './Input/Input';

// Usage in other files
import { Button, Card, Input } from '@/components/common';
```

### Screen Exports

```typescript
// screens/index.ts
export { HomeScreen } from './home/HomeScreen';
export { ProfileScreen } from './profile/ProfileScreen';
export { SettingsScreen } from './settings/SettingsScreen';
```

---

## Constants Organization

### Colors

```typescript
// constants/colors.ts
export const COLORS = {
  primary: '#6366f1',
  secondary: '#8b5cf6',
  success: '#10b981',
  error: '#ef4444',
  warning: '#f59e0b',

  text: {
    primary: '#1f2937',
    secondary: '#6b7280',
    tertiary: '#9ca3af',
  },

  background: {
    primary: '#ffffff',
    secondary: '#f9fafb',
    tertiary: '#f3f4f6',
  },

  border: '#e5e7eb',
} as const;
```

### Sizes

```typescript
// constants/sizes.ts
export const SIZES = {
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
  },

  fontSize: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 18,
    xl: 24,
    xxl: 32,
  },

  borderRadius: {
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999,
  },
} as const;
```

---

## Type Organization

### Centralized Types

```typescript
// types/index.ts
export interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
}

export interface Post {
  id: string;
  userId: string;
  title: string;
  content: string;
  createdAt: Date;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
```

### Feature-Specific Types

```typescript
// screens/auth/types.ts
export interface LoginFormData {
  email: string;
  password: string;
}

export interface RegisterFormData extends LoginFormData {
  name: string;
  confirmPassword: string;
}
```

---

## Best Practices

1. **One Component Per File**: Keep components in separate files
2. **Barrel Exports**: Use index.ts for convenient imports
3. **Consistent Naming**: Follow naming conventions strictly
4. **Logical Grouping**: Group related files together
5. **Flat Structure**: Avoid deep nesting (max 3-4 levels)
6. **Separate Concerns**: Keep styles, types, and logic separate when needed
7. **Path Aliases**: Use `@/` alias for cleaner imports
8. **Constants**: Extract magic numbers and strings to constants

---

## Path Aliases

Configure TypeScript path aliases in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@/components/*": ["src/components/*"],
      "@/screens/*": ["src/screens/*"],
      "@/hooks/*": ["src/hooks/*"],
      "@/utils/*": ["src/utils/*"],
      "@/types/*": ["src/types/*"]
    }
  }
}
```

Usage:

```typescript
// Instead of
import { Button } from '../../../components/common/Button';

// Use
import { Button } from '@/components/common/Button';
```
