import React from 'react';
import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import type { RootStackParamList } from './types';
import { useAuth } from '../contexts/AuthContext';
import { theme } from '../theme/colors';
import LoginScreen from '../screens/auth/LoginScreen';
import RegisterScreen from '../screens/auth/RegisterScreen';
import VerifyEmailScreen from '../screens/auth/VerifyEmailScreen';
import ChatListScreen from '../screens/chat/ChatListScreen';
import ConversationScreen from '../screens/chat/ConversationScreen';
import ContactsScreen from '../screens/chat/ContactsScreen';
import StewraVoiceScreen from '../screens/chat/StewraVoiceScreen';
import CallScreen from '../screens/call/CallScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

/** Global nav ref so services (voipCallService) can navigate outside of React tree. */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

interface ConversationRouteOptionsArgs {
  readonly route: RouteProp<RootStackParamList, 'Conversation'>;
}

function conversationScreenOptions(args: ConversationRouteOptionsArgs): NativeStackNavigationOptions {
  return { title: args.route.params.title };
}

export default function RootNavigator(): React.JSX.Element {
  const { user, loading } = useAuth();

  if (loading) {
    return <></>;
  }

  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.textPrimary,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        {user === null ? (
          <>
            <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Register" component={RegisterScreen} options={{ title: 'Create account' }} />
            <Stack.Screen
              name="VerifyEmail"
              component={VerifyEmailScreen}
              options={{ title: 'Verify email' }}
            />
          </>
        ) : (
          <>
            <Stack.Screen name="ChatList" component={ChatListScreen} options={{ title: 'Stewra' }} />
            <Stack.Screen
              name="Conversation"
              component={ConversationScreen}
              options={conversationScreenOptions}
            />
            <Stack.Screen name="Contacts" component={ContactsScreen} options={{ title: 'Contacts' }} />
            <Stack.Screen
              name="StewraVoice"
              component={StewraVoiceScreen}
              options={{ title: 'Talk to Stewra' }}
            />
            <Stack.Screen
              name="Call"
              component={CallScreen}
              options={{ headerShown: false, presentation: 'fullScreenModal' }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
