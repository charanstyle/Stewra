import type { ExpoConfig } from 'expo/config';
import { theme } from './src/theme/colors';

/**
 * Expo SDK 54 dev-client config (not Expo Go — CallKit/PushKit/VoIP and the
 * custom Android call-ringing foreground service all require native modules
 * unavailable in Expo Go). Config plugins under `plugins/` inject the native
 * VoIP/CallKit AppDelegate wiring and the Android incoming-call foreground
 * service into the generated iOS/Android projects on `expo prebuild`.
 */
const config: ExpoConfig = {
  name: 'Stewra',
  slug: 'stewra',
  scheme: 'stewra',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  newArchEnabled: true,
  icon: './assets/icon.png',
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: theme.colors.background,
  },
  assetBundlePatterns: ['**/*'],
  ios: {
    bundleIdentifier: 'com.stewra.app',
    supportsTablet: true,
    infoPlist: {
      NSMicrophoneUsageDescription: 'Stewra uses your microphone for voice messages and calls.',
      NSCameraUsageDescription: 'Stewra uses your camera for video calls.',
      UIBackgroundModes: ['voip', 'audio', 'remote-notification'],
    },
    entitlements: {
      'aps-environment': 'production',
    },
  },
  android: {
    package: 'com.stewra.app',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: theme.colors.background,
    },
    permissions: [
      'RECORD_AUDIO',
      'CAMERA',
      'POST_NOTIFICATIONS',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_SHORT_SERVICE',
      'USE_FULL_SCREEN_INTENT',
      'VIBRATE',
    ],
  },
  plugins: [
    'expo-dev-client',
    'expo-secure-store',
    [
      'expo-notifications',
      {
        icon: './assets/icon.png',
        color: theme.colors.primary,
      },
    ],
    [
      'react-native-webrtc',
      {
        cameraPermission: 'Stewra uses your camera for video calls.',
        microphonePermission: 'Stewra uses your microphone for voice messages and calls.',
      },
    ],
    './plugins/withAndroidNotificationAvatar.cjs',
    './plugins/withAndroidCallForegroundService.cjs',
    './plugins/withVoipAppDelegate.cjs',
  ],
  extra: {
    eas: {
      // Set via `eas init` / EAS dashboard; not committed as a literal here
      // per the project's no-hardcoding rule.
    },
  },
};

export default config;
