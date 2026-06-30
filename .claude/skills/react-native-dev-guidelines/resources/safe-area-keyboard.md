# Safe Area and Keyboard Handling

Complete guide to handling safe areas and keyboard interactions in React Native.

---

## Table of Contents

- [SafeAreaView](#safeareaview)
- [KeyboardAvoidingView](#keyboardavoidingview)
- [Keyboard Module](#keyboard-module)
- [Common Patterns](#common-patterns)
- [Best Practices](#best-practices)

---

## SafeAreaView

SafeAreaView ensures content is displayed within the safe area boundaries of a device.

### Basic SafeAreaView

```typescript
import { SafeAreaView, StyleSheet } from 'react-native';

export const Screen: React.FC = () => (
  <SafeAreaView style={styles.safeArea}>
    <View style={styles.content}>
      {/* Your content */}
    </View>
  </SafeAreaView>
);

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  content: {
    flex: 1,
    padding: 16,
  },
});
```

### With ScrollView

```typescript
export const ScrollableScreen: React.FC = () => (
  <SafeAreaView style={styles.safeArea}>
    <ScrollView contentContainerStyle={styles.scrollContent}>
      {/* Content that needs scrolling */}
    </ScrollView>
  </SafeAreaView>
);

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  scrollContent: {
    padding: 16,
  },
});
```

### iOS-Only Safe Area

```typescript
import { Platform, SafeAreaView, View } from 'react-native';

export const Screen: React.FC = () => {
  const Container = Platform.OS === 'ios' ? SafeAreaView : View;

  return (
    <Container style={styles.container}>
      {/* Content */}
    </Container>
  );
};
```

---

## KeyboardAvoidingView

KeyboardAvoidingView automatically adjusts its position when the keyboard appears.

### Basic KeyboardAvoidingView

```typescript
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
} from 'react-native';

export const LoginScreen: React.FC = () => (
  <KeyboardAvoidingView
    style={styles.container}
    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
  >
    <ScrollView contentContainerStyle={styles.scrollContent}>
      {/* Form inputs */}
    </ScrollView>
  </KeyboardAvoidingView>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    flexGrow: 1,
    justifyContent: 'center',
  },
});
```

### Behavior Options

```typescript
// 'padding' - Add padding to bottom (iOS recommended)
<KeyboardAvoidingView behavior="padding">

// 'height' - Adjust container height (Android recommended)
<KeyboardAvoidingView behavior="height">

// 'position' - Adjust container position
<KeyboardAvoidingView behavior="position">
```

### Combined with SafeAreaView

```typescript
export const FormScreen: React.FC = () => (
  <SafeAreaView style={styles.safeArea}>
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <TextInput placeholder="Email" style={styles.input} />
        <TextInput placeholder="Password" style={styles.input} secureTextEntry />
        <Button title="Submit" onPress={handleSubmit} />
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>
);

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    flexGrow: 1,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
});
```

---

## Keyboard Module

The Keyboard module provides methods to interact with keyboard events.

### Dismiss Keyboard

```typescript
import { Keyboard, TouchableWithoutFeedback } from 'react-native';

export const FormScreen: React.FC = () => (
  <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
    <View style={styles.container}>
      <TextInput placeholder="Email" />
    </View>
  </TouchableWithoutFeedback>
);
```

### Keyboard Events

```typescript
import { useEffect } from 'react';
import { Keyboard, KeyboardEvent } from 'react-native';

export const Screen: React.FC = () => {
  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', (e: KeyboardEvent) => {
      console.log('Keyboard shown', e.endCoordinates.height);
    });

    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      console.log('Keyboard hidden');
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  return <View>{/* content */}</View>;
};
```

### Keyboard Height

```typescript
import { useState, useEffect } from 'react';
import { Keyboard, KeyboardEvent } from 'react-native';

export function useKeyboardHeight(): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showSubscription = Keyboard.addListener(
      'keyboardDidShow',
      (e: KeyboardEvent) => {
        setKeyboardHeight(e.endCoordinates.height);
      }
    );

    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  return keyboardHeight;
}

// Usage
const keyboardHeight = useKeyboardHeight();
```

---

## Common Patterns

### Chat Screen Pattern

```typescript
export const ChatScreen: React.FC = () => {
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    const keyboardDidShowListener = Keyboard.addListener(
      'keyboardDidShow',
      () => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }
    );

    return () => {
      keyboardDidShowListener.remove();
    };
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={({ item }) => <MessageItem message={item} />}
          keyExtractor={(item) => item.id}
        />
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder="Type a message..."
          />
          <Button title="Send" onPress={handleSend} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginRight: 8,
  },
});
```

### Modal Form Pattern

```typescript
export const ModalForm: React.FC<{ visible: boolean }> = ({ visible }) => (
  <Modal visible={visible} animationType="slide">
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Create Post</Text>
          <Button title="Close" onPress={handleClose} />
        </View>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <TextInput
            placeholder="Title"
            style={styles.input}
          />
          <TextInput
            placeholder="Description"
            style={[styles.input, styles.textArea]}
            multiline
            numberOfLines={4}
          />
          <Button title="Submit" onPress={handleSubmit} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>
);

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
  },
  scrollContent: {
    padding: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  textArea: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
});
```

### Bottom Sheet Pattern

```typescript
export const BottomSheetForm: React.FC = () => {
  const [isKeyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const keyboardDidShowListener = Keyboard.addListener(
      'keyboardDidShow',
      () => setKeyboardVisible(true)
    );
    const keyboardDidHideListener = Keyboard.addListener(
      'keyboardDidHide',
      () => setKeyboardVisible(false)
    );

    return () => {
      keyboardDidShowListener.remove();
      keyboardDidHideListener.remove();
    };
  }, []);

  return (
    <View style={[styles.bottomSheet, isKeyboardVisible && styles.bottomSheetExpanded]}>
      <TextInput placeholder="Search..." style={styles.input} />
    </View>
  );
};

const styles = StyleSheet.create({
  bottomSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
  },
  bottomSheetExpanded: {
    bottom: 300, // Adjust based on keyboard height
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
  },
});
```

---

## Best Practices

1. **Always Use SafeAreaView**: Especially for iOS devices with notches
2. **Platform-Specific Behavior**: Use different behaviors for iOS and Android
3. **Keyboard Offset**: Adjust `keyboardVerticalOffset` based on header height
4. **Dismiss on Tap**: Allow users to dismiss keyboard by tapping outside
5. **ScrollView with Forms**: Use ScrollView inside KeyboardAvoidingView for long forms
6. **Test on Real Devices**: Keyboard behavior differs between simulator and real devices
7. **Handle Keyboard Events**: Listen to keyboard events for custom behavior
8. **Consider Tab Bars**: Add additional offset for bottom tab bars
