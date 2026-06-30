# Performance Optimization

Complete guide to optimizing React Native app performance.

---

## Table of Contents

- [React.memo](#reactmemo)
- [useMemo and useCallback](#usememo-and-usecallback)
- [FlatList Optimization](#flatlist-optimization)
- [Image Optimization](#image-optimization)
- [Common Issues](#common-issues)
- [Best Practices](#best-practices)

---

## React.memo

Memoize components to prevent unnecessary re-renders.

### Basic React.memo

```typescript
import React from 'react';

interface ListItemProps {
  title: string;
  subtitle: string;
  onPress: () => void;
}

export const ListItem: React.FC<ListItemProps> = React.memo(
  ({ title, subtitle, onPress }) => (
    <Pressable onPress={onPress} style={styles.item}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </Pressable>
  )
);
```

### Custom Comparison Function

```typescript
export const ListItem: React.FC<ListItemProps> = React.memo(
  ({ title, subtitle, onPress }) => {
    return (
      <Pressable onPress={onPress} style={styles.item}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </Pressable>
    );
  },
  (prevProps, nextProps) => {
    // Return true if props are equal (skip re-render)
    return (
      prevProps.title === nextProps.title &&
      prevProps.subtitle === nextProps.subtitle
    );
  }
);
```

---

## useMemo and useCallback

Memoize expensive calculations and function references.

### useMemo

```typescript
import { useMemo } from 'react';

export const ExpensiveComponent: React.FC<{ items: Item[] }> = ({ items }) => {
  // Memoize expensive calculation
  const sortedItems = useMemo(() => {
    console.log('Sorting items...');
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  return (
    <FlatList
      data={sortedItems}
      renderItem={({ item }) => <ItemRow item={item} />}
    />
  );
};
```

### useCallback

```typescript
import { useCallback } from 'react';

export const ParentComponent: React.FC = () => {
  const [count, setCount] = useState(0);

  // Memoize callback to prevent child re-renders
  const handlePress = useCallback(() => {
    console.log('Button pressed');
  }, []); // Empty deps - function never changes

  return (
    <View>
      <Text>{count}</Text>
      <Button onPress={() => setCount(count + 1)} />
      <ChildComponent onPress={handlePress} />
    </View>
  );
};

// Child only re-renders if onPress changes
const ChildComponent = React.memo<{ onPress: () => void }>(({ onPress }) => (
  <Pressable onPress={onPress}>
    <Text>Click me</Text>
  </Pressable>
));
```

### When to Use

```typescript
// ❌ DON'T memoize simple values
const doubled = useMemo(() => count * 2, [count]); // Overhead not worth it

// ✅ DO memoize expensive calculations
const filtered = useMemo(
  () => items.filter(item => item.price > 100),
  [items]
); // Worth it for large arrays

// ❌ DON'T useCallback for inline functions
<Button onPress={useCallback(() => console.log('hi'), [])} />

// ✅ DO useCallback for props to memoized components
const handlePress = useCallback(() => console.log('hi'), []);
<MemoizedButton onPress={handlePress} />
```

---

## FlatList Optimization

Optimize list rendering for better performance.

### Basic Optimization

```typescript
import { FlatList } from 'react-native';

interface Item {
  id: string;
  title: string;
}

export const OptimizedList: React.FC<{ data: Item[] }> = ({ data }) => (
  <FlatList
    data={data}
    renderItem={({ item }) => <ListItem item={item} />}
    keyExtractor={(item) => item.id}
    // Performance optimizations
    removeClippedSubviews={true}
    maxToRenderPerBatch={10}
    updateCellsBatchingPeriod={50}
    initialNumToRender={10}
    windowSize={5}
  />
);
```

### getItemLayout

```typescript
const ITEM_HEIGHT = 80;

<FlatList
  data={data}
  renderItem={renderItem}
  keyExtractor={keyExtractor}
  // Optimize scrolling performance
  getItemLayout={(data, index) => ({
    length: ITEM_HEIGHT,
    offset: ITEM_HEIGHT * index,
    index,
  })}
/>
```

### Memoized renderItem

```typescript
const renderItem = useCallback(
  ({ item }: { item: Item }) => <ListItem item={item} />,
  []
);

<FlatList
  data={data}
  renderItem={renderItem}
  keyExtractor={(item) => item.id}
/>
```

### ListHeaderComponent and ListFooterComponent

```typescript
<FlatList
  data={data}
  renderItem={renderItem}
  ListHeaderComponent={<Header />}
  ListFooterComponent={<Footer />}
  // Don't recreate components on every render
  ListEmptyComponent={EmptyState}
/>
```

---

## Image Optimization

Optimize image loading and rendering.

### Use Expo Image

```typescript
import { Image } from 'expo-image';

// Optimized image component
<Image
  source={{ uri: 'https://example.com/image.jpg' }}
  style={styles.image}
  contentFit="cover"
  transition={200}
  placeholder={blurhash}
  cachePolicy="memory-disk"
/>
```

### Image Sizing

```typescript
// ❌ AVOID - Full resolution image
<Image
  source={{ uri: 'https://example.com/image-4k.jpg' }}
  style={{ width: 100, height: 100 }}
/>

// ✅ PREFER - Appropriate size
<Image
  source={{
    uri: 'https://example.com/image-thumbnail.jpg',
    width: 100,
    height: 100,
  }}
  style={{ width: 100, height: 100 }}
/>
```

### Lazy Loading Images

```typescript
import { useState } from 'react';
import { Image, View, ActivityIndicator } from 'react-native';

export const LazyImage: React.FC<{ uri: string }> = ({ uri }) => {
  const [loading, setLoading] = useState(true);

  return (
    <View style={styles.container}>
      {loading && <ActivityIndicator />}
      <Image
        source={{ uri }}
        style={styles.image}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
      />
    </View>
  );
};
```

---

## Common Issues

### 1. Inline Function Creation

```typescript
// ❌ AVOID - Creates new function on every render
<FlatList
  data={items}
  renderItem={({ item }) => (
    <Pressable onPress={() => handlePress(item.id)}>
      <Text>{item.title}</Text>
    </Pressable>
  )}
/>

// ✅ PREFER - Stable function reference
const renderItem = useCallback(({ item }: { item: Item }) => (
  <ItemComponent item={item} onPress={handlePress} />
), [handlePress]);

<FlatList data={items} renderItem={renderItem} />
```

### 2. Inline Style Objects

```typescript
// ❌ AVOID - Creates new object on every render
<View style={{ padding: 16, backgroundColor: '#fff' }} />

// ✅ PREFER - StyleSheet or memoized
<View style={styles.container} />

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: '#fff',
  },
});
```

### 3. Large State Objects

```typescript
// ❌ AVOID - Updating entire object
const [user, setUser] = useState(largeObject);
setUser({ ...user, name: 'New Name' }); // Recreates entire object

// ✅ PREFER - Split state
const [userName, setUserName] = useState('');
const [userEmail, setUserEmail] = useState('');
```

### 4. Console.log in Production

```typescript
// ❌ AVOID - Logs slow down app
console.log('User data:', user);

// ✅ PREFER - Only in development
if (__DEV__) {
  console.log('User data:', user);
}
```

---

## Best Practices

### 1. Use FlashList for Large Lists

```typescript
import { FlashList } from '@shopify/flash-list';

<FlashList
  data={data}
  renderItem={renderItem}
  estimatedItemSize={80}
/>
```

### 2. Avoid Anonymous Functions in JSX

```typescript
// ❌ AVOID
<Button onPress={() => handlePress()} />

// ✅ PREFER
<Button onPress={handlePress} />
```

### 3. Use Key Prop Correctly

```typescript
// ❌ AVOID - Index as key
{items.map((item, index) => (
  <Item key={index} item={item} />
))}

// ✅ PREFER - Stable unique identifier
{items.map((item) => (
  <Item key={item.id} item={item} />
))}
```

### 4. Debounce Expensive Operations

```typescript
import { useMemo } from 'react';
import debounce from 'lodash/debounce';

const debouncedSearch = useMemo(
  () => debounce((query: string) => {
    performSearch(query);
  }, 300),
  []
);
```

### 5. Use InteractionManager

```typescript
import { InteractionManager } from 'react-native';

useEffect(() => {
  InteractionManager.runAfterInteractions(() => {
    // Run expensive operation after animations complete
    loadHeavyData();
  });
}, []);
```

### 6. Lazy Load Screens

```typescript
import { lazy, Suspense } from 'react';

const ProfileScreen = lazy(() => import('./screens/ProfileScreen'));

<Suspense fallback={<Loading />}>
  <ProfileScreen />
</Suspense>
```

### 7. Use Native Driver

```typescript
// ✅ Enable native driver for animations
Animated.timing(value, {
  toValue: 1,
  duration: 300,
  useNativeDriver: true, // ✅
}).start();
```

### 8. Monitor Performance

```typescript
import { LogBox, PerformanceObserver } from 'react-native';

// Monitor performance in development
if (__DEV__) {
  const observer = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => {
      console.log(entry.name, entry.duration);
    });
  });

  observer.observe({ entryTypes: ['measure'] });
}
```

---

## Performance Checklist

- [ ] Use React.memo for pure components
- [ ] Use useCallback for function props
- [ ] Use useMemo for expensive calculations
- [ ] Optimize FlatList with proper props
- [ ] Use getItemLayout for fixed-height items
- [ ] Avoid inline functions and style objects
- [ ] Use proper key props (not index)
- [ ] Optimize images (size, caching, lazy loading)
- [ ] Split large state objects
- [ ] Remove console.log in production
- [ ] Use native driver for animations
- [ ] Debounce expensive operations
- [ ] Use InteractionManager for heavy tasks
- [ ] Monitor performance regularly
