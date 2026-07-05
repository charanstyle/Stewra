import * as Notifications from 'expo-notifications';

/**
 * Ensure the runtime notification permission is granted.
 *
 * On Android 13+ (API 33) the app MUST hold `POST_NOTIFICATIONS` or Jetpack Core-Telecom cannot post
 * the incoming-call `CallStyle` notification and revokes the ring ("a Call-Style-Notification … hasn't
 * posted in time, stopping delegation"). Without it a fresh install shows the caller "Calling…" while
 * the callee never rings. `POST_NOTIFICATIONS` is declared in the manifest (app.config.ts); this asks
 * for the runtime grant so we don't rely on a manual `adb shell pm grant`.
 *
 * Uses expo-notifications: `getPermissionsAsync` already reports granted on Android < 13 (install-time)
 * and on iOS self-managed CallKit calls, so both are treated as granted without a dialog. Never throws —
 * a denial degrades the incoming ring but must not break call-layer init.
 *
 * Returns whether notifications are permitted.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) {
      return true;
    }
    if (!current.canAskAgain) {
      return false;
    }
    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted;
  } catch {
    return false;
  }
}
