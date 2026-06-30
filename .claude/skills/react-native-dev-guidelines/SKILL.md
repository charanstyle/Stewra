---
name: react-native-dev-guidelines
description: React Native + Expo development guidelines (frontend/ directory). Mobile app patterns including Expo SDK, React Navigation, StyleSheet, Expo modules, Reanimated, performance optimization, and TypeScript best practices. Use when working with the mobile application.
---

# React Native Development Guidelines (Expo)

## Purpose

Comprehensive guide for React Native + Expo mobile application development (frontend/ directory), emphasizing native mobile patterns, Expo modules, navigation, and performance optimization.

## When to Use This Skill

Automatically activates when working on:
- Creating screens or components in frontend/
- Building mobile features
- Using Expo modules (Camera, Notifications, etc.)
- Navigation with React Navigation
- Styling with React Native StyleSheet
- Mobile-specific patterns
- TypeScript best practices for mobile

---

## Quick Start

### New Screen Checklist

- [ ] Use `React.FC<Props>` pattern with TypeScript
- [ ] Create StyleSheet at bottom of file
- [ ] Use SafeAreaView for proper spacing
- [ ] Handle keyboard with KeyboardAvoidingView
- [ ] Use proper navigation types
- [ ] Add loading and error states
- [ ] Test on both iOS and Android
- [ ] No `any` types - use proper TypeScript

### New Component Checklist

- [ ] Use TypeScript interfaces for props
- [ ] Create StyleSheet for styles
- [ ] Make reusable and composable
- [ ] Use memo for performance if needed
- [ ] Handle touch feedback with Pressable
- [ ] Support dark mode if applicable
- [ ] Export as default

---

## Tech Stack Overview

### Core Framework
- **Expo SDK 54** - Development framework
- **React Native 0.81.5** - Mobile framework
- **React 19** + **TypeScript 5**

### Navigation
- **React Navigation v7** - Stack and Tab navigation

### UI & Styling
- **React Native StyleSheet** - Native styling
- **Expo modules** - Camera, Notifications, Image Picker
- **React Native Reanimated v4** - Animations
- **Expo Vector Icons** - Icon library

### State & Storage
- **AsyncStorage** - Persistent storage
- **React Context** - Global state

### Forms & Validation
- **Yup** - Schema validation

---

## Core Principles (9 Key Rules)

### 1. SafeAreaView Always

```typescript
import { SafeAreaView } from 'react-native';

export const Screen: React.FC = () => (
  <SafeAreaView style={styles.container}>
    {/* Content */}
  </SafeAreaView>
);
```

See [safe-area-keyboard.md](resources/safe-area-keyboard.md) for details.

### 2. TypeScript Everywhere - NO 'any'

```typescript
// ❌ NEVER
function handleData(data: any) { }

// ✅ ALWAYS
interface User { id: string; name: string; }
function handleData(data: User) { }
```

See [typescript-standards.md](resources/typescript-standards.md) for standards.

### 3. StyleSheet at Bottom

```typescript
export const Component: React.FC = () => (
  <View style={styles.container} />
);

const styles = StyleSheet.create({
  container: { padding: 16 },
});
```

See [styling-guide.md](resources/styling-guide.md) for patterns.

### 4. Pressable Over TouchableOpacity

```typescript
<Pressable onPress={handlePress} style={({ pressed }) => [
  styles.button,
  pressed && styles.pressed,
]}>
  <Text>Button</Text>
</Pressable>
```

See [touchable-components.md](resources/touchable-components.md) for details.

### 5. Type-Safe Navigation

```typescript
type RootStackParamList = {
  Home: undefined;
  Profile: { userId: string };
};

type ProfileScreenProps = StackScreenProps<RootStackParamList, 'Profile'>;
```

See [navigation-patterns.md](resources/navigation-patterns.md) for navigation.

### 6. Optimize FlatList

```typescript
<FlatList
  data={items}
  renderItem={renderItem}
  keyExtractor={(item) => item.id}
  removeClippedSubviews={true}
  maxToRenderPerBatch={10}
  windowSize={5}
/>
```

See [performance-optimization.md](resources/performance-optimization.md) for optimization.

### 7. Use Expo Modules

```typescript
import { Camera } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
```

See [expo-modules.md](resources/expo-modules.md) for module usage.

### 8. Performance with React.memo

```typescript
export const ListItem: React.FC<Props> = React.memo(({ item }) => (
  <View>{/* ... */}</View>
));
```

### 9. API Contracts MUST Use @stewra/shared-types

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
    body: JSON.stringify(data),
  });
  return response.json();
};
```

**Why:** Ensures type safety across frontend and backend. Any API change immediately shows type errors.

**Applies to:**
- All API request bodies
- All API response types
- WebSocket message types
- All data received from or sent to backend

---

## File Organization

```
frontend/src/
  screens/              # Screen components
    auth/
      LoginScreen.tsx
    dashboard/
      HomeScreen.tsx

  components/           # Reusable components
    common/
      Button.tsx
      Card.tsx

  navigation/           # Navigation setup
    MainNavigator.tsx
    types.ts

  hooks/                # Custom hooks
    useAuth.ts

  services/             # API services
    api.ts

  contexts/             # React contexts
    AuthContext.tsx

  utils/                # Utilities
    formatters.ts

  types/                # TypeScript types
    index.ts
```

See [file-organization.md](resources/file-organization.md) for detailed structure.

---

## Anti-Patterns to Avoid

❌ Using `any` type
❌ Inline style objects
❌ TouchableOpacity (use Pressable)
❌ Index as key in lists
❌ Missing SafeAreaView
❌ Ignoring keyboard handling
❌ Not memoizing expensive components
❌ Hardcoded values (use constants)
❌ Missing TypeScript types

---

## Navigation Guide

| Need to... | Read this |
|------------|-----------|
| Setup navigation, routing | [navigation-patterns.md](resources/navigation-patterns.md) |
| Style components, layouts | [styling-guide.md](resources/styling-guide.md) |
| Handle safe areas, keyboard | [safe-area-keyboard.md](resources/safe-area-keyboard.md) |
| Create touchable components | [touchable-components.md](resources/touchable-components.md) |
| Use Camera, Notifications | [expo-modules.md](resources/expo-modules.md) |
| Create animations | [animations.md](resources/animations.md) |
| Store data locally | [async-storage.md](resources/async-storage.md) |
| Build forms, validation | [forms-validation.md](resources/forms-validation.md) |
| TypeScript best practices | [typescript-standards.md](resources/typescript-standards.md) |
| Optimize performance | [performance-optimization.md](resources/performance-optimization.md) |
| Organize files and folders | [file-organization.md](resources/file-organization.md) |

---

## Resource Files

### [navigation-patterns.md](resources/navigation-patterns.md)
Stack navigation, tabs, hooks, type-safe routing, deep linking

### [styling-guide.md](resources/styling-guide.md)
StyleSheet patterns, responsive design, platform-specific styles

### [safe-area-keyboard.md](resources/safe-area-keyboard.md)
SafeAreaView, KeyboardAvoidingView, keyboard events

### [touchable-components.md](resources/touchable-components.md)
Pressable, TouchableOpacity, interaction patterns

### [expo-modules.md](resources/expo-modules.md)
Camera, ImagePicker, Notifications, Haptics, and more

### [animations.md](resources/animations.md)
Reanimated v4, spring/timing animations, gestures

### [async-storage.md](resources/async-storage.md)
Persistent storage, custom hooks, best practices

### [forms-validation.md](resources/forms-validation.md)
Form handling, Yup validation, custom hooks

### [typescript-standards.md](resources/typescript-standards.md)
NO 'any' rule, proper typing, type utilities

### [performance-optimization.md](resources/performance-optimization.md)
React.memo, useMemo, FlatList optimization, image optimization

### [file-organization.md](resources/file-organization.md)
Project structure, naming conventions, path aliases

---

## Related Skills

- **website-dev-guidelines** - Web app patterns (website/ directory)
- **backend-dev-guidelines** - Backend API patterns (backend/ directory)
- **error-tracking** - Error tracking with Sentry

---

**Skill Status**: COMPLETE ✅
**Line Count**: 327 lines (< 400) ✅
**Progressive Disclosure**: 11 resource files ✅
