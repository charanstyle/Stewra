# Styling Guide

Complete guide to styling React Native components with StyleSheet.

---

## Table of Contents

- [Basic StyleSheet Pattern](#basic-stylesheet-pattern)
- [Conditional Styles](#conditional-styles)
- [Responsive Styling](#responsive-styling)
- [Platform-Specific Styles](#platform-specific-styles)
- [Shadow and Elevation](#shadow-and-elevation)
- [Flexbox Layouts](#flexbox-layouts)
- [Best Practices](#best-practices)

---

## Basic StyleSheet Pattern

Always define styles using StyleSheet.create at the bottom of the file.

### Component with StyleSheet

```typescript
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface CardProps {
  title: string;
  description: string;
}

export const Card: React.FC<CardProps> = ({ title, description }) => {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.description}>{description}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3, // Android shadow
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: '#6b7280',
    lineHeight: 20,
  },
});

export default Card;
```

### Inline Style Arrays

```typescript
<View style={[styles.button, styles.primaryButton]} />

// With conditional styles
<View style={[
  styles.button,
  isActive && styles.buttonActive,
  disabled && styles.buttonDisabled,
]} />
```

---

## Conditional Styles

### Boolean Conditions

```typescript
const styles = StyleSheet.create({
  button: {
    padding: 12,
    borderRadius: 8,
  },
  buttonActive: {
    backgroundColor: '#6366f1',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});

// Usage
<Pressable
  style={[
    styles.button,
    isActive && styles.buttonActive,
    disabled && styles.buttonDisabled,
  ]}
>
  <Text>Button</Text>
</Pressable>
```

### Ternary Operators

```typescript
<View style={[
  styles.container,
  { backgroundColor: isDark ? '#1f2937' : '#ffffff' }
]} />
```

### Dynamic Style Functions

```typescript
const getButtonStyle = (variant: 'primary' | 'secondary') => {
  return [
    styles.button,
    variant === 'primary' ? styles.primaryButton : styles.secondaryButton,
  ];
};

<Pressable style={getButtonStyle('primary')}>
  <Text>Button</Text>
</Pressable>
```

---

## Responsive Styling

### Using Dimensions

```typescript
import { Dimensions, StyleSheet } from 'react-native';

const { width, height } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    width: width * 0.9, // 90% of screen width
    height: height * 0.3, // 30% of screen height
  },
  tablet: {
    width: width > 768 ? 600 : width * 0.9, // Fixed width on tablets
  },
});
```

### Listening to Dimension Changes

```typescript
import { useWindowDimensions } from 'react-native';

export const ResponsiveComponent: React.FC = () => {
  const { width, height } = useWindowDimensions();

  return (
    <View style={{ width: width * 0.9 }}>
      <Text>Width: {width}</Text>
      <Text>Height: {height}</Text>
    </View>
  );
};
```

### Breakpoint Pattern

```typescript
const BREAKPOINTS = {
  sm: 320,
  md: 768,
  lg: 1024,
};

const getResponsiveValue = <T,>(width: number, values: { sm: T; md: T; lg: T }): T => {
  if (width >= BREAKPOINTS.lg) return values.lg;
  if (width >= BREAKPOINTS.md) return values.md;
  return values.sm;
};

// Usage
const { width } = useWindowDimensions();
const fontSize = getResponsiveValue(width, { sm: 14, md: 16, lg: 18 });
```

---

## Platform-Specific Styles

### Platform.select

```typescript
import { Platform, StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  container: {
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      },
      android: {
        elevation: 5,
      },
    }),
  },
  text: {
    ...Platform.select({
      ios: {
        fontFamily: 'System',
      },
      android: {
        fontFamily: 'Roboto',
      },
    }),
  },
});
```

### Platform.OS

```typescript
const styles = StyleSheet.create({
  container: {
    paddingTop: Platform.OS === 'ios' ? 44 : 0,
  },
});
```

---

## Shadow and Elevation

### iOS Shadow

```typescript
const styles = StyleSheet.create({
  card: {
    // iOS shadow properties
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
});
```

### Android Elevation

```typescript
const styles = StyleSheet.create({
  card: {
    // Android elevation
    elevation: 5,
  },
});
```

### Cross-Platform Shadow

```typescript
const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    // iOS shadows
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    // Android elevation
    elevation: 3,
  },
});
```

---

## Flexbox Layouts

### Basic Flex

```typescript
const styles = StyleSheet.create({
  container: {
    flex: 1, // Takes full available space
    flexDirection: 'row', // 'row' | 'column' | 'row-reverse' | 'column-reverse'
    justifyContent: 'center', // 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | 'space-evenly'
    alignItems: 'center', // 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'baseline'
  },
});
```

### Flex Grow and Shrink

```typescript
const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
  },
  sidebar: {
    flexGrow: 0, // Don't grow
    flexShrink: 0, // Don't shrink
    width: 200,
  },
  content: {
    flexGrow: 1, // Take remaining space
    flexShrink: 1, // Allow shrinking
  },
});
```

### Common Layout Patterns

```typescript
// Centered content
const styles = StyleSheet.create({
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

// Space between items
const styles = StyleSheet.create({
  spaceBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});

// Equal columns
const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
  },
  column: {
    flex: 1, // Each column takes equal space
  },
});
```

---

## Best Practices

### 1. StyleSheet at Bottom

Always define StyleSheet.create at the bottom of the file:

```typescript
export const MyComponent: React.FC = () => {
  return <View style={styles.container} />;
};

// Styles at bottom
const styles = StyleSheet.create({
  container: {
    // styles
  },
});
```

### 2. No Inline Styles

```typescript
// ❌ AVOID
<View style={{ padding: 16, backgroundColor: '#fff' }} />

// ✅ PREFER
<View style={styles.container} />

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: '#fff',
  },
});
```

### 3. Reusable Style Objects

```typescript
// Define common styles
const COLORS = {
  primary: '#6366f1',
  secondary: '#8b5cf6',
  text: '#1f2937',
  background: '#ffffff',
};

const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

const styles = StyleSheet.create({
  container: {
    padding: SPACING.md,
    backgroundColor: COLORS.background,
  },
  title: {
    color: COLORS.text,
    marginBottom: SPACING.sm,
  },
});
```

### 4. Semantic Naming

```typescript
// ❌ AVOID
const styles = StyleSheet.create({
  box1: { /* ... */ },
  text1: { /* ... */ },
});

// ✅ PREFER
const styles = StyleSheet.create({
  container: { /* ... */ },
  title: { /* ... */ },
  description: { /* ... */ },
  button: { /* ... */ },
});
```

### 5. StyleSheet.flatten for Complex Logic

```typescript
import { StyleSheet } from 'react-native';

const baseStyle = { padding: 16 };
const conditionalStyle = isActive ? { backgroundColor: '#6366f1' } : {};

// Flatten complex style objects
const flattenedStyle = StyleSheet.flatten([baseStyle, conditionalStyle]);
```

### 6. Avoid Deep Nesting

```typescript
// ❌ AVOID
<View style={styles.outer}>
  <View style={styles.middle}>
    <View style={styles.inner}>
      <Text>Content</Text>
    </View>
  </View>
</View>

// ✅ PREFER - flatten when possible
<View style={styles.container}>
  <Text>Content</Text>
</View>
```

---

## Common Styling Patterns

### Card Component

```typescript
const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginVertical: 8,
    marginHorizontal: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
});
```

### Button Component

```typescript
const styles = StyleSheet.create({
  button: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
});
```

### Input Component

```typescript
const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#1f2937',
  },
  inputFocused: {
    borderColor: '#6366f1',
  },
  inputError: {
    borderColor: '#ef4444',
  },
});
```
