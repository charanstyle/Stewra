import type { ExpoConfig } from 'expo/config';
// Import the raw palette from JSON, NOT from `./src/theme/colors` (a .ts module):
// Expo evaluates this config with a plain-Node loader that cannot resolve nested
// `.ts` requires at `expo prebuild` time. `.json` resolves natively, and it is the
// same single-source palette that `src/theme/colors.ts` builds `theme` from.
import palette from './src/theme/palette.json';

/**
 * Expo SDK 55 dev-client config (not Expo Go — WebRTC and the native call UI
 * require native modules unavailable in Expo Go). New Architecture is enabled.
 *
 * Call UI, VoIP push, ringtone/dialtone, and the audio session are all owned by
 * `expo-callkit-telecom` (CallKit on iOS, Jetpack androidx.core-telecom on
 * Android). Its config plugin injects the CallKit/PushKit AppDelegate wiring,
 * the Android Core-Telecom services, the FCM messaging service, the VoIP
 * background mode + entitlement, and the SiriKit call intents — superseding the
 * three custom `plugins/*.cjs` mods (withVoipAppDelegate / withAndroidCall-
 * ForegroundService / withAndroidNotificationAvatar) that this migration removed.
 * `@config-plugins/react-native-webrtc` remains, now serving the LiveKit WebRTC
 * fork that `expo-callkit-telecom` coordinates its RTCAudioSession with.
 */
const config: ExpoConfig = {
  name: 'Stewra',
  slug: 'stewra',
  scheme: 'stewra',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  // New Architecture is the only architecture in SDK 55 / RN 0.83 (the legacy
  // bridge was removed), so `newArchEnabled` is no longer a config key — it is
  // unconditionally on.
  icon: './assets/icon.png',
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: palette.background,
  },
  assetBundlePatterns: ['**/*'],
  ios: {
    bundleIdentifier: 'com.stewra.app',
    supportsTablet: true,
    infoPlist: {
      NSMicrophoneUsageDescription: 'Stewra uses your microphone for voice messages and calls.',
      NSCameraUsageDescription: 'Stewra uses your camera for video calls.',
    },
  },
  android: {
    package: 'com.stewra.app',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: palette.background,
    },
    // Firebase (FCM) config for background call-push. Absent until the Firebase
    // project is provisioned; when present, drop it at ./google-services.json
    // and Android VoIP push begins working. Foreground/socket calls work without
    // it. Reads from an env var so the file path isn't hardcoded per the
    // no-hardcoding rule and CI/prebuild can point at a secret-managed location.
    ...(process.env['GOOGLE_SERVICES_JSON']
      ? { googleServicesFile: process.env['GOOGLE_SERVICES_JSON'] }
      : {}),
    permissions: [
      'RECORD_AUDIO',
      'CAMERA',
      'POST_NOTIFICATIONS',
      // Core-Telecom self-managed calling.
      'MANAGE_OWN_CALLS',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_MICROPHONE',
      'USE_FULL_SCREEN_INTENT',
      'VIBRATE',
    ],
  },
  plugins: [
    'expo-dev-client',
    'expo-secure-store',
    // SDK 55 requires an explicit config-plugin entry for expo-audio (voice notes).
    'expo-audio',
    [
      'expo-notifications',
      {
        icon: './assets/icon.png',
        color: palette.primary,
      },
    ],
    [
      'expo-build-properties',
      {
        // CallKit + PushKit floor; androidx.core-telecom requires API 26+.
        ios: { deploymentTarget: '16.0' },
        android: { minSdkVersion: 26 },
      },
    ],
    [
      // react-native-webrtc ships no in-package config plugin; this Expo plugin
      // (v14 targets SDK 55) configures the LiveKit WebRTC fork's native build.
      '@config-plugins/react-native-webrtc',
      {
        cameraPermission: 'Stewra uses your camera for video calls.',
        microphonePermission: 'Stewra uses your microphone for voice messages and calls.',
      },
    ],
    [
      // Owns the system call UI, audio session, ringtone/dialtone, VoIP push
      // (PushKit + FCM parsed natively), and the CallKit/Core-Telecom lifecycle.
      'expo-callkit-telecom',
      {
        microphonePermission: 'Stewra uses your microphone for voice messages and calls.',
        cameraPermission: 'Stewra uses your camera for video calls.',
      },
    ],
  ],
  extra: {
    eas: {
      // Set via `eas init` / EAS dashboard; not committed as a literal here
      // per the project's no-hardcoding rule.
    },
  },
};

export default config;
