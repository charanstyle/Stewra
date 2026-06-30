# Touchable Components

Complete guide to touchable components and interaction patterns in React Native.

---

## Table of Contents

- [Pressable (Recommended)](#pressable-recommended)
- [TouchableOpacity](#touchableopacity)
- [TouchableHighlight](#touchablehighlight)
- [TouchableWithoutFeedback](#touchablewithoutfeedback)
- [Best Practices](#best-practices)

---

## Pressable (Recommended)

Pressable is the recommended component for handling touch interactions. It provides more control over interaction states.

### Basic Pressable

```typescript
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
  <Pressable
    onPress={onPress}
    style={({ pressed }) => [
      styles.button,
      styles[variant],
      pressed && styles.pressed,
    ]}
  >
    {({ pressed }) => (
      <Text style={[styles.text, pressed && styles.textPressed]}>
        {title}
      </Text>
    )}
  </Pressable>
);

const styles = StyleSheet.create({
  button: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
  },
  primary: {
    backgroundColor: '#6366f1',
  },
  secondary: {
    backgroundColor: '#e5e7eb',
  },
  pressed: {
    opacity: 0.7,
  },
  text: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  textPressed: {
    opacity: 0.8,
  },
});
```

### Pressable with All Events

```typescript
<Pressable
  onPress={() => console.log('Pressed')}
  onPressIn={() => console.log('Press started')}
  onPressOut={() => console.log('Press ended')}
  onLongPress={() => console.log('Long pressed')}
  delayLongPress={500} // Long press delay in ms
  hitSlop={8} // Expand touchable area
  pressRetentionOffset={8} // Drag distance before canceling
  disabled={false}
  android_ripple={{
    color: 'rgba(0, 0, 0, 0.1)',
    borderless: false,
  }}
  style={({ pressed }) => [
    styles.button,
    pressed && styles.buttonPressed,
  ]}
>
  <Text>Button</Text>
</Pressable>
```

### Pressable with Hover (Web)

```typescript
<Pressable
  style={({ pressed, hovered }) => [
    styles.button,
    hovered && styles.hovered,
    pressed && styles.pressed,
  ]}
>
  {({ pressed, hovered }) => (
    <Text style={[
      styles.text,
      hovered && styles.textHovered,
      pressed && styles.textPressed,
    ]}>
      Hover me
    </Text>
  )}
</Pressable>
```

### Disabled State

```typescript
interface ButtonProps {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}

export const Button: React.FC<ButtonProps> = ({ title, onPress, disabled }) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    style={[styles.button, disabled && styles.buttonDisabled]}
  >
    <Text style={[styles.text, disabled && styles.textDisabled]}>
      {title}
    </Text>
  </Pressable>
);

const styles = StyleSheet.create({
  button: {
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#6366f1',
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#d1d5db',
  },
  text: {
    color: '#ffffff',
    fontWeight: '600',
  },
  textDisabled: {
    color: '#9ca3af',
  },
});
```

---

## TouchableOpacity

TouchableOpacity reduces opacity when pressed. Simple but less flexible than Pressable.

### Basic TouchableOpacity

```typescript
import { TouchableOpacity, Text, StyleSheet } from 'react-native';

export const Button: React.FC<{ onPress: () => void }> = ({ onPress }) => (
  <TouchableOpacity
    onPress={onPress}
    activeOpacity={0.7}
    style={styles.button}
  >
    <Text style={styles.text}>Press Me</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  button: {
    padding: 12,
    backgroundColor: '#6366f1',
    borderRadius: 8,
    alignItems: 'center',
  },
  text: {
    color: '#ffffff',
    fontWeight: '600',
  },
});
```

### With Disabled State

```typescript
<TouchableOpacity
  onPress={onPress}
  disabled={isLoading}
  activeOpacity={0.7}
  style={[styles.button, isLoading && styles.buttonDisabled]}
>
  <Text style={styles.text}>
    {isLoading ? 'Loading...' : 'Submit'}
  </Text>
</TouchableOpacity>
```

---

## TouchableHighlight

TouchableHighlight shows an underlay color when pressed. Good for list items.

### Basic TouchableHighlight

```typescript
import { TouchableHighlight, Text, StyleSheet } from 'react-native';

export const ListItem: React.FC<{ onPress: () => void }> = ({ onPress }) => (
  <TouchableHighlight
    onPress={onPress}
    underlayColor="#f3f4f6"
    style={styles.item}
  >
    <Text style={styles.text}>List Item</Text>
  </TouchableHighlight>
);

const styles = StyleSheet.create({
  item: {
    padding: 16,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  text: {
    fontSize: 16,
  },
});
```

### With Single Child Requirement

```typescript
// ❌ WRONG - Multiple children
<TouchableHighlight onPress={onPress}>
  <Text>Title</Text>
  <Text>Subtitle</Text>
</TouchableHighlight>

// ✅ CORRECT - Single child wrapper
<TouchableHighlight onPress={onPress}>
  <View>
    <Text>Title</Text>
    <Text>Subtitle</Text>
  </View>
</TouchableHighlight>
```

---

## TouchableWithoutFeedback

TouchableWithoutFeedback has no visual feedback. Use sparingly.

### Basic Usage

```typescript
import { TouchableWithoutFeedback, View, Keyboard } from 'react-native';

export const DismissKeyboard: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
    <View style={{ flex: 1 }}>
      {children}
    </View>
  </TouchableWithoutFeedback>
);
```

### Modal Backdrop

```typescript
<Modal visible={visible} transparent>
  <TouchableWithoutFeedback onPress={onClose}>
    <View style={styles.backdrop}>
      <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
        <View style={styles.modal}>
          {/* Modal content */}
        </View>
      </TouchableWithoutFeedback>
    </View>
  </TouchableWithoutFeedback>
</Modal>

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modal: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 20,
    width: '80%',
  },
});
```

---

## Best Practices

### 1. Prefer Pressable

```typescript
// ✅ RECOMMENDED - Use Pressable for new code
<Pressable onPress={onPress} style={styles.button}>
  <Text>Button</Text>
</Pressable>

// ⚠️ OK - TouchableOpacity is acceptable
<TouchableOpacity onPress={onPress} style={styles.button}>
  <Text>Button</Text>
</TouchableOpacity>
```

### 2. Hit Slop for Small Targets

```typescript
// Make small buttons easier to tap
<Pressable
  onPress={onPress}
  hitSlop={12} // Expand touch area by 12px
  style={styles.smallButton}
>
  <Icon name="close" size={16} />
</Pressable>
```

### 3. Android Ripple

```typescript
<Pressable
  onPress={onPress}
  android_ripple={{
    color: 'rgba(0, 0, 0, 0.1)',
    borderless: false,
    radius: 20,
  }}
  style={styles.button}
>
  <Text>Android Ripple</Text>
</Pressable>
```

### 4. Haptic Feedback

```typescript
import * as Haptics from 'expo-haptics';

<Pressable
  onPress={() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    handlePress();
  }}
  style={styles.button}
>
  <Text>Button with Haptics</Text>
</Pressable>
```

### 5. Loading State

```typescript
interface ButtonProps {
  title: string;
  onPress: () => void;
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({ title, onPress, loading }) => (
  <Pressable
    onPress={onPress}
    disabled={loading}
    style={[styles.button, loading && styles.buttonDisabled]}
  >
    {loading ? (
      <ActivityIndicator color="#ffffff" />
    ) : (
      <Text style={styles.text}>{title}</Text>
    )}
  </Pressable>
);
```

### 6. Icon Button

```typescript
interface IconButtonProps {
  icon: string;
  onPress: () => void;
  size?: number;
  color?: string;
}

export const IconButton: React.FC<IconButtonProps> = ({
  icon,
  onPress,
  size = 24,
  color = '#000',
}) => (
  <Pressable
    onPress={onPress}
    hitSlop={8}
    style={({ pressed }) => [
      styles.iconButton,
      pressed && styles.iconButtonPressed,
    ]}
  >
    <Ionicons name={icon} size={size} color={color} />
  </Pressable>
);

const styles = StyleSheet.create({
  iconButton: {
    padding: 8,
    borderRadius: 20,
  },
  iconButtonPressed: {
    backgroundColor: '#f3f4f6',
  },
});
```

### 7. Card Pressable

```typescript
export const Card: React.FC<{ onPress: () => void }> = ({ onPress }) => (
  <Pressable
    onPress={onPress}
    style={({ pressed }) => [
      styles.card,
      pressed && styles.cardPressed,
    ]}
  >
    <Text style={styles.title}>Card Title</Text>
    <Text style={styles.description}>Card description</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  cardPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.98 }],
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: '#6b7280',
  },
});
```

---

## Migration Guide

### From TouchableOpacity to Pressable

```typescript
// Before (TouchableOpacity)
<TouchableOpacity
  onPress={handlePress}
  activeOpacity={0.7}
  style={styles.button}
>
  <Text>Button</Text>
</TouchableOpacity>

// After (Pressable)
<Pressable
  onPress={handlePress}
  style={({ pressed }) => [
    styles.button,
    pressed && { opacity: 0.7 },
  ]}
>
  <Text>Button</Text>
</Pressable>
```

### From TouchableHighlight to Pressable

```typescript
// Before (TouchableHighlight)
<TouchableHighlight
  onPress={handlePress}
  underlayColor="#f3f4f6"
  style={styles.item}
>
  <View>
    <Text>Item</Text>
  </View>
</TouchableHighlight>

// After (Pressable)
<Pressable
  onPress={handlePress}
  style={({ pressed }) => [
    styles.item,
    pressed && { backgroundColor: '#f3f4f6' },
  ]}
>
  <Text>Item</Text>
</Pressable>
```
