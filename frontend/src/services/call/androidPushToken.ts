/**
 * Android call-push registration + killed-app cold-start recovery. On iOS,
 * voipCallService.ts owns push registration (PushKit/CallKit); on Android there
 * is no PushKit equivalent, so we register a plain FCM device token instead
 * (read via `Notifications.getDevicePushTokenAsync()`, NOT the Expo push
 * token — the backend's call-push service sends raw high-priority FCM data
 * messages directly via the Firebase Admin SDK, matching the
 * `withAndroidNotificationAvatar` plugin's `StewraMessagingService`, so it
 * needs the native FCM registration id).
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { api } from '../api';
import { callService } from './callService';
import IncomingCallRing from './incomingCallRing';

function isAndroidToken(
  token: Notifications.DevicePushToken,
): token is Notifications.DevicePushToken & { data: string } {
  return token.type === 'android' && typeof token.data === 'string';
}

export async function registerAndroidCallPushToken(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (permission.status !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync();
      if (requested.status !== 'granted') {
        return;
      }
    }
    const token = await Notifications.getDevicePushTokenAsync();
    if (isAndroidToken(token)) {
      await api.registerCallPushToken({ platform: 'android', fcmToken: token.data });
    }
  } catch {
    // Degrade gracefully: the socket-based call flow still rings while foregrounded.
  }
}

/**
 * On a killed-app cold start, Android's deep-link delivery to JS is unreliable,
 * so the foreground IncomingCallRingService (started directly by the FCM
 * service) is the source of truth for "is a call currently ringing". Adopt it
 * into callService so the incoming-call modal still appears.
 */
export function adoptPendingAndroidCall(): void {
  if (Platform.OS !== 'android') {
    return;
  }
  const pending = IncomingCallRing.getPendingCall();
  if (!pending) {
    return;
  }
  const callKind = pending.callKind === 'video' ? 'video' : 'audio';
  callService.adoptIncoming({
    callId: pending.callId,
    conversationId: pending.conversationId,
    callKind,
    peer: { id: '', displayName: pending.callerName },
  });
}
