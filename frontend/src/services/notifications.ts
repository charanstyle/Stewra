import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Ensure the runtime notification permission is granted.
 *
 * On Android 13+ (API 33) the app MUST hold `POST_NOTIFICATIONS` or Jetpack Core-Telecom cannot post
 * the incoming-call `CallStyle` notification and revokes the ring ("a Call-Style-Notification … hasn't
 * posted in time, stopping delegation"). Without it a fresh install shows the caller "Calling…" while
 * the callee never rings. `POST_NOTIFICATIONS` is declared in the manifest (app.config.ts); this asks
 * for the runtime grant so we don't rely on a manual `adb shell pm grant`.
 *
 * Uses core React Native `PermissionsAndroid` (no extra native module) so it works in the existing
 * dev-client build. On Android < 13 the permission is install-time (no dialog) and on iOS it's a no-op
 * for self-managed CallKit calls, so both are treated as granted.
 *
 * Returns whether notifications are permitted. Never throws — a denial degrades the incoming ring but
 * must not break call-layer init.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  // POST_NOTIFICATIONS only became a runtime permission in API 33; earlier versions grant it at install.
  if (typeof Platform.Version === 'number' && Platform.Version < 33) {
    return true;
  }
  try {
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(permission)) {
      return true;
    }
    const result = await PermissionsAndroid.request(permission);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}
