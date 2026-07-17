import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider } from './src/contexts/AuthContext';
import { ContactsProvider } from './src/contexts/ContactsContext';
import { CallProvider } from './src/contexts/CallContext';
import { PushProvider } from './src/contexts/PushContext';
import RootNavigator from './src/navigation/RootNavigator';
import { theme } from './src/theme/colors';

/**
 * Provider order matters: AuthProvider first (everything below needs `user`),
 * then ContactsProvider (feeds callService's peer-name resolver), then
 * CallProvider (owns the global incoming-call modal + CallKit/VoIP wiring and
 * needs both auth and the resolver in place before it registers signaling
 * listeners), then PushProvider (registers the Expo push token — needs auth,
 * since the register endpoint is behind requireAuth — and routes notification
 * taps through `navigationRef`), then the navigator itself.
 */
export default function App(): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <SafeAreaProvider>
        <AuthProvider>
          <ContactsProvider>
            <CallProvider>
              <PushProvider>
                <RootNavigator />
              </PushProvider>
            </CallProvider>
          </ContactsProvider>
        </AuthProvider>
        <StatusBar style="light" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
