# Navigation Patterns

Complete guide to React Navigation v7 patterns in React Native.

---

## Table of Contents

- [Stack Navigator](#stack-navigator)
- [Bottom Tab Navigator](#bottom-tab-navigator)
- [Navigation Hooks](#navigation-hooks)
- [Navigation Types](#navigation-types)
- [Common Patterns](#common-patterns)

---

## Stack Navigator

Stack navigation allows users to navigate between screens with history.

### Basic Stack Setup

```typescript
import { createStackNavigator } from '@react-navigation/stack';
import type { StackScreenProps } from '@react-navigation/stack';

// Define navigation types
type RootStackParamList = {
  Home: undefined;
  Profile: { userId: string };
  Settings: undefined;
};

export type HomeScreenProps = StackScreenProps<RootStackParamList, 'Home'>;
export type ProfileScreenProps = StackScreenProps<RootStackParamList, 'Profile'>;

const Stack = createStackNavigator<RootStackParamList>();

export function AppNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#6366f1' },
        headerTintColor: '#fff',
      }}
    >
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
    </Stack.Navigator>
  );
}
```

### Custom Header Options

```typescript
<Stack.Navigator>
  <Stack.Screen
    name="Profile"
    component={ProfileScreen}
    options={{
      title: 'User Profile',
      headerShown: true,
      headerBackTitle: 'Back',
      headerRight: () => (
        <Button title="Save" onPress={handleSave} />
      ),
    }}
  />
</Stack.Navigator>
```

### Dynamic Header Options

```typescript
<Stack.Screen
  name="Profile"
  component={ProfileScreen}
  options={({ route }) => ({
    title: route.params.userName || 'Profile',
  })}
/>
```

---

## Bottom Tab Navigator

Tab navigation provides quick access to top-level screens.

### Basic Tab Setup

```typescript
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';

type TabParamList = {
  Home: undefined;
  Search: undefined;
  Profile: undefined;
};

const Tab = createBottomTabNavigator<TabParamList>();

export function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap;

          if (route.name === 'Home') {
            iconName = focused ? 'home' : 'home-outline';
          } else if (route.name === 'Search') {
            iconName = focused ? 'search' : 'search-outline';
          } else {
            iconName = focused ? 'person' : 'person-outline';
          }

          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: '#6366f1',
        tabBarInactiveTintColor: 'gray',
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Search" component={SearchScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}
```

### Tab Badge

```typescript
<Tab.Screen
  name="Messages"
  component={MessagesScreen}
  options={{
    tabBarBadge: 3, // Number badge
    tabBarBadgeStyle: { backgroundColor: '#ef4444' },
  }}
/>
```

### Hide Tab Bar on Specific Screens

```typescript
<Tab.Screen
  name="Details"
  component={DetailsScreen}
  options={{
    tabBarStyle: { display: 'none' }, // Hide tab bar
  }}
/>
```

---

## Navigation Hooks

Hooks provide access to navigation and route objects.

### useNavigation

```typescript
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';

type ProfileScreenNavigationProp = StackNavigationProp<RootStackParamList, 'Profile'>;

export const ProfileScreen: React.FC = () => {
  const navigation = useNavigation<ProfileScreenNavigationProp>();

  const handleBack = () => {
    navigation.goBack();
  };

  const goToSettings = () => {
    navigation.navigate('Settings');
  };

  const goToProfileWithParams = () => {
    navigation.navigate('Profile', { userId: '123' });
  };

  return (
    <View>
      <Button title="Back" onPress={handleBack} />
      <Button title="Settings" onPress={goToSettings} />
    </View>
  );
};
```

### useRoute

```typescript
import { useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';

type ProfileScreenRouteProp = RouteProp<RootStackParamList, 'Profile'>;

export const ProfileScreen: React.FC = () => {
  const route = useRoute<ProfileScreenRouteProp>();
  const { userId } = route.params;

  return <Text>Profile: {userId}</Text>;
};
```

### useFocusEffect

```typescript
import { useFocusEffect } from '@react-navigation/native';
import { useCallback } from 'react';

export const HomeScreen: React.FC = () => {
  useFocusEffect(
    useCallback(() => {
      // Called when screen comes into focus
      console.log('Screen focused');

      return () => {
        // Called when screen loses focus (cleanup)
        console.log('Screen unfocused');
      };
    }, [])
  );

  return <View>{/* content */}</View>;
};
```

### useIsFocused

```typescript
import { useIsFocused } from '@react-navigation/native';

export const HomeScreen: React.FC = () => {
  const isFocused = useIsFocused();

  useEffect(() => {
    if (isFocused) {
      // Screen is focused
      fetchData();
    }
  }, [isFocused]);

  return <View>{/* content */}</View>;
};
```

---

## Navigation Types

Proper TypeScript typing for navigation.

### Complete Type Setup

```typescript
// types/navigation.ts
import type { StackScreenProps } from '@react-navigation/stack';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';

// Stack param lists
export type RootStackParamList = {
  Main: undefined;
  Profile: { userId: string };
  Settings: undefined;
  PostDetail: { postId: string };
};

// Tab param list
export type MainTabParamList = {
  Home: undefined;
  Search: undefined;
  Notifications: undefined;
  Profile: undefined;
};

// Composite types for nested navigation
export type HomeScreenProps = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Home'>,
  StackScreenProps<RootStackParamList>
>;

export type ProfileScreenProps = StackScreenProps<RootStackParamList, 'Profile'>;
```

### Using Navigation Types in Screens

```typescript
import type { ProfileScreenProps } from '../types/navigation';

export const ProfileScreen: React.FC<ProfileScreenProps> = ({ navigation, route }) => {
  const { userId } = route.params;

  const handleNavigate = () => {
    navigation.navigate('Settings');
  };

  return <View>{/* content */}</View>;
};
```

---

## Common Patterns

### Nested Navigators

```typescript
function MainStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Tabs" component={MainTabs} options={{ headerShown: false }} />
      <Stack.Screen name="Details" component={DetailsScreen} />
    </Stack.Navigator>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}
```

### Modal Presentation

```typescript
<Stack.Navigator>
  <Stack.Screen name="Home" component={HomeScreen} />
  <Stack.Screen
    name="Modal"
    component={ModalScreen}
    options={{
      presentation: 'modal',
      headerShown: false,
    }}
  />
</Stack.Navigator>
```

### Conditional Navigation

```typescript
export function RootNavigator() {
  const { isAuthenticated } = useAuth();

  return (
    <Stack.Navigator>
      {isAuthenticated ? (
        <Stack.Screen name="Main" component={MainNavigator} />
      ) : (
        <Stack.Screen name="Auth" component={AuthNavigator} />
      )}
    </Stack.Navigator>
  );
}
```

### Deep Linking

```typescript
const linking = {
  prefixes: ['myapp://', 'https://myapp.com'],
  config: {
    screens: {
      Home: 'home',
      Profile: 'profile/:userId',
      Settings: 'settings',
    },
  },
};

<NavigationContainer linking={linking}>
  <Stack.Navigator>
    {/* screens */}
  </Stack.Navigator>
</NavigationContainer>
```

### Navigation State Persistence

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';

const PERSISTENCE_KEY = 'NAVIGATION_STATE';

export function App() {
  const [isReady, setIsReady] = useState(false);
  const [initialState, setInitialState] = useState();

  useEffect(() => {
    const restoreState = async () => {
      try {
        const savedStateString = await AsyncStorage.getItem(PERSISTENCE_KEY);
        const state = savedStateString ? JSON.parse(savedStateString) : undefined;

        if (state !== undefined) {
          setInitialState(state);
        }
      } finally {
        setIsReady(true);
      }
    };

    restoreState();
  }, []);

  if (!isReady) {
    return null;
  }

  return (
    <NavigationContainer
      initialState={initialState}
      onStateChange={(state) =>
        AsyncStorage.setItem(PERSISTENCE_KEY, JSON.stringify(state))
      }
    >
      {/* navigators */}
    </NavigationContainer>
  );
}
```

---

## Best Practices

1. **Type Safety**: Always define param lists with TypeScript
2. **Proper Props**: Use proper screen props types for navigation and route
3. **Navigation Options**: Configure options at the navigator level when possible
4. **Focus Effects**: Use `useFocusEffect` for screen-specific side effects
5. **Nested Navigation**: Keep navigation hierarchy simple and logical
6. **Deep Linking**: Configure deep linking for important screens
7. **State Persistence**: Persist navigation state for better UX
8. **Modal Handling**: Use proper modal presentation for modal flows
