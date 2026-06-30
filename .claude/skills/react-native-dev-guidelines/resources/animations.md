# Animations with Reanimated

Complete guide to creating smooth animations using React Native Reanimated v4.

---

## Table of Contents

- [Basic Animation](#basic-animation)
- [Spring Animations](#spring-animations)
- [Timing Animations](#timing-animations)
- [Gesture Animations](#gesture-animations)
- [Layout Animations](#layout-animations)
- [Common Patterns](#common-patterns)

---

## Basic Animation

### Shared Values and Animated Styles

```typescript
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Pressable, StyleSheet } from 'react-native';

export const AnimatedButton: React.FC = () => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.9);
  };

  const handlePressOut = () => {
    scale.value = withSpring(1);
  };

  return (
    <Pressable onPressIn={handlePressIn} onPressOut={handlePressOut}>
      <Animated.View style={[styles.button, animatedStyle]}>
        <Text>Animated Button</Text>
      </Animated.View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    padding: 16,
    backgroundColor: '#6366f1',
    borderRadius: 8,
    alignItems: 'center',
  },
});
```

---

## Spring Animations

Spring animations have natural physics-based motion.

### Basic Spring

```typescript
import { useSharedValue, withSpring } from 'react-native-reanimated';

const offset = useSharedValue(0);

// Animate with spring
offset.value = withSpring(100, {
  damping: 10,
  stiffness: 100,
  mass: 1,
  overshootClamping: false,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 2,
});
```

### Custom Spring Configuration

```typescript
const SPRING_CONFIG = {
  damping: 20,
  stiffness: 90,
  mass: 1,
};

const animate = () => {
  offset.value = withSpring(200, SPRING_CONFIG);
};
```

---

## Timing Animations

Timing animations have linear or easing-based motion.

### Basic Timing

```typescript
import { withTiming, Easing } from 'react-native-reanimated';

const opacity = useSharedValue(0);

// Linear timing
opacity.value = withTiming(1, {
  duration: 500,
});

// With easing
opacity.value = withTiming(1, {
  duration: 500,
  easing: Easing.bezier(0.25, 0.1, 0.25, 1),
});
```

### Available Easings

```typescript
// Common easing functions
Easing.linear
Easing.ease
Easing.quad
Easing.cubic
Easing.bezier(x1, y1, x2, y2)
Easing.in(Easing.quad)
Easing.out(Easing.quad)
Easing.inOut(Easing.quad)
```

### Fade In Animation

```typescript
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { useEffect } from 'react';

export const FadeInView: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const opacity = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 500 });
  }, []);

  return (
    <Animated.View style={animatedStyle}>
      {children}
    </Animated.View>
  );
};
```

---

## Gesture Animations

Animations driven by user gestures.

### Pan Gesture

```typescript
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';

export const Draggable: React.FC = () => {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  const gesture = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = e.translationX;
      translateY.value = e.translationY;
    })
    .onEnd(() => {
      translateX.value = withSpring(0);
      translateY.value = withSpring(0);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.box, animatedStyle]} />
    </GestureDetector>
  );
};
```

### Tap Gesture with Scale

```typescript
const scale = useSharedValue(1);

const tapGesture = Gesture.Tap()
  .onBegin(() => {
    scale.value = withSpring(0.9);
  })
  .onFinalize(() => {
    scale.value = withSpring(1);
  });

const animatedStyle = useAnimatedStyle(() => ({
  transform: [{ scale: scale.value }],
}));
```

---

## Layout Animations

Animate layout changes automatically.

### Entering Animations

```typescript
import Animated, { FadeIn, SlideInRight } from 'react-native-reanimated';

// Fade in
<Animated.View entering={FadeIn}>
  <Text>Fade In</Text>
</Animated.View>

// Slide in from right
<Animated.View entering={SlideInRight.duration(500)}>
  <Text>Slide In</Text>
</Animated.View>
```

### Exiting Animations

```typescript
import { FadeOut, SlideOutLeft } from 'react-native-reanimated';

<Animated.View exiting={FadeOut}>
  <Text>Fade Out</Text>
</Animated.View>

<Animated.View exiting={SlideOutLeft.duration(500)}>
  <Text>Slide Out</Text>
</Animated.View>
```

### Layout Transition

```typescript
import { Layout } from 'react-native-reanimated';

<Animated.View layout={Layout.springify()}>
  <Text>Smooth layout changes</Text>
</Animated.View>
```

---

## Common Patterns

### Bounce Animation

```typescript
export const BounceButton: React.FC = () => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    scale.value = withSpring(1.2, { damping: 2 }, () => {
      scale.value = withSpring(1);
    });
  };

  return (
    <Pressable onPress={handlePress}>
      <Animated.View style={[styles.button, animatedStyle]}>
        <Text>Bounce</Text>
      </Animated.View>
    </Pressable>
  );
};
```

### Shake Animation

```typescript
export const ShakeView: React.FC<{ trigger: boolean }> = ({ trigger }) => {
  const translateX = useSharedValue(0);

  useEffect(() => {
    if (trigger) {
      translateX.value = withSequence(
        withTiming(-10, { duration: 50 }),
        withTiming(10, { duration: 50 }),
        withTiming(-10, { duration: 50 }),
        withTiming(10, { duration: 50 }),
        withTiming(0, { duration: 50 })
      );
    }
  }, [trigger]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <Animated.View style={animatedStyle}>
      {/* content */}
    </Animated.View>
  );
};
```

### Rotate Animation

```typescript
export const RotatingLoader: React.FC = () => {
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 1000, easing: Easing.linear }),
      -1, // Repeat indefinitely
      false
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View style={animatedStyle}>
      <ActivityIndicator />
    </Animated.View>
  );
};
```

### Swipe to Delete

```typescript
export const SwipeableItem: React.FC = () => {
  const translateX = useSharedValue(0);
  const itemHeight = useSharedValue(80);
  const opacity = useSharedValue(1);

  const gesture = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = Math.min(0, e.translationX);
    })
    .onEnd(() => {
      if (translateX.value < -100) {
        // Delete threshold reached
        translateX.value = withTiming(-500);
        itemHeight.value = withTiming(0);
        opacity.value = withTiming(0);
      } else {
        translateX.value = withSpring(0);
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    height: itemHeight.value,
    opacity: opacity.value,
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.item, animatedStyle]}>
        <Text>Swipe left to delete</Text>
      </Animated.View>
    </GestureDetector>
  );
};
```

### Progress Bar

```typescript
export const ProgressBar: React.FC<{ progress: number }> = ({ progress }) => {
  const width = useSharedValue(0);

  useEffect(() => {
    width.value = withTiming(progress, { duration: 500 });
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    width: `${width.value}%`,
  }));

  return (
    <View style={styles.progressContainer}>
      <Animated.View style={[styles.progressBar, animatedStyle]} />
    </View>
  );
};

const styles = StyleSheet.create({
  progressContainer: {
    height: 4,
    backgroundColor: '#e5e7eb',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#6366f1',
  },
});
```

---

## Best Practices

1. **Use Shared Values**: Always use `useSharedValue` for animated values
2. **Animated Styles**: Use `useAnimatedStyle` for style animations
3. **Worklet**: Functions inside `useAnimatedStyle` run on UI thread
4. **Spring for Touch**: Use spring animations for touch interactions
5. **Timing for UI**: Use timing for UI transitions
6. **Layout Animations**: Use built-in layout animations when possible
7. **Performance**: Keep animations on UI thread for 60fps
8. **Cleanup**: No cleanup needed for shared values
