import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { BottomTabNavigationOptions } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from './types';
import ChatListScreen from '../screens/chat/ChatListScreen';
import ContactsScreen from '../screens/chat/ContactsScreen';
import StewraVoiceScreen from '../screens/chat/StewraVoiceScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import { ChatIcon, ContactsIcon, MicIcon, SettingsIcon } from '../components/icons/Icons';
import LogoutButton from '../components/LogoutButton';
import { theme } from '../theme/colors';

const Tab = createBottomTabNavigator<MainTabParamList>();

interface TabBarIconArgs {
  readonly color: string;
  readonly size: number;
}

/**
 * The authenticated home: a bottom tab bar over Chats, Contacts, and the Talk-to-Stewra voice screen.
 * Each tab carries its own header (so the parent stack hides its header for this route). Icons are the
 * shared inline SVGs — never emoji — tinted by the active/inactive tab color.
 */
export default function MainTabs(): React.JSX.Element {
  const screenOptions: BottomTabNavigationOptions = {
    headerStyle: { backgroundColor: theme.colors.surface },
    headerTintColor: theme.colors.textPrimary,
    headerRight: () => <LogoutButton />,
    tabBarStyle: {
      backgroundColor: theme.colors.surface,
      borderTopColor: theme.colors.border,
    },
    tabBarActiveTintColor: theme.colors.primary,
    tabBarInactiveTintColor: theme.colors.textSecondary,
    sceneStyle: { backgroundColor: theme.colors.background },
  };

  return (
    <Tab.Navigator screenOptions={screenOptions}>
      <Tab.Screen
        name="Chats"
        component={ChatListScreen}
        options={{
          title: 'Chats',
          tabBarButtonTestID: 'tab-chats',
          tabBarIcon: ({ color, size }: TabBarIconArgs) => <ChatIcon color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="Contacts"
        component={ContactsScreen}
        options={{
          title: 'Contacts',
          tabBarIcon: ({ color, size }: TabBarIconArgs) => <ContactsIcon color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="StewraVoice"
        component={StewraVoiceScreen}
        options={{
          title: 'Talk to Stewra',
          tabBarLabel: 'Stewra',
          tabBarIcon: ({ color, size }: TabBarIconArgs) => <MicIcon color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }: TabBarIconArgs) => <SettingsIcon color={color} size={size} />,
        }}
      />
    </Tab.Navigator>
  );
}
