import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  EMAIL_APPROVAL_ACTION_APPROVE,
  EMAIL_APPROVAL_ACTION_DENY,
  EMAIL_APPROVAL_ANDROID_CHANNEL_ID,
  EMAIL_APPROVAL_CATEGORY,
} from '@stewra/shared-types';
import type { PushPlatform } from '@stewra/shared-types';
import { api } from './api';
import { ensureNotificationPermission } from './notifications';

/**
 * The Expo push channel: the actionable "approve the email Stewra drafted" prompt.
 *
 * SEPARATE from the call-ring push (`voipCallService.sendPushToken` → `/calls/push-token`), which
 * registers a native VoIP token owned by `expo-callkit-telecom` on a raw-FCM path. This registers an
 * EXPO push token, which is what Expo's push service addresses. Two token types, two paths, two tables.
 *
 * ⚠️ NOTHING HERE CAN SEND AN EMAIL. A notification is a prompt, not authority. Approving reaches the
 * authenticated `POST /messages/:id/confirm-email` carrying the device's stored JWT — the same endpoint
 * the in-app Send button uses. The push only ever carries a `messageId`.
 */

/**
 * The Android channel the approval prompt lands on. `PRIVATE` means a locked screen shows that a
 * notification arrived but hides its text until unlocked — so the prompt can't be read (or acted on)
 * by someone who just picked the phone up. Defence in depth: the body is already generic and carries
 * no email content. No-op on iOS, which has no channels.
 */
async function registerEmailApprovalChannel(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  await Notifications.setNotificationChannelAsync(EMAIL_APPROVAL_ANDROID_CHANNEL_ID, {
    name: 'Email approvals',
    description: 'Asks you to approve an email Stewra drafted from WhatsApp.',
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}

/** The Approve/Deny buttons on the approval notification. */
async function registerEmailApprovalCategory(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(EMAIL_APPROVAL_CATEGORY, [
    {
      identifier: EMAIL_APPROVAL_ACTION_APPROVE,
      buttonTitle: 'Approve',
      // Opens the app rather than acting in the background. This is the whole security design on
      // Android: the OS cannot gate a notification button behind biometrics, so the only way to make
      // Approve prove "it's you" is to open the app and run the check there. See EmailApprovalScreen.
      options: { opensAppToForeground: true },
    },
    {
      identifier: EMAIL_APPROVAL_ACTION_DENY,
      buttonTitle: 'Deny',
      // Runs in the background with no auth check, deliberately. Denying only ever CANCELS a draft —
      // it destroys a capability rather than exercising one, so friction here would protect nothing
      // and would punish the user for the safe choice.
      options: { opensAppToForeground: false },
    },
  ]);
}

/**
 * The EAS project id, baked in from `EAS_PROJECT_ID` via app.config.ts's `extra.eas.projectId`.
 * `extra` is untyped by construction (Expo's config bag), so this narrows rather than asserts.
 */
function requireProjectId(): string {
  const eas: unknown = Constants.expoConfig?.extra?.['eas'];
  const projectId =
    typeof eas === 'object' && eas !== null && 'projectId' in eas ? eas.projectId : undefined;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    // Loud, per the project's no-silent-fallback rule. A missing project id means the build was made
    // without EAS_PROJECT_ID, and Expo cannot address this device at all — approval pushes would just
    // never arrive, which is exactly the kind of silence that hides a broken deploy for weeks.
    throw new Error(
      '[push] Missing extra.eas.projectId — set EAS_PROJECT_ID (see frontend/.env.example) and rebuild.',
    );
  }
  return projectId;
}

/**
 * Register this device for approval pushes. Called once the user is authenticated (the endpoint is
 * behind requireAuth), and safe to call again — the server upserts one token per (user, platform).
 *
 * Returns whether the device is now registered. Never throws: a device that can't receive pushes must
 * still run the app, and approval always remains available in-app. The reasons it can fail are logged
 * rather than swallowed silently.
 */
export async function registerForApprovalPush(): Promise<boolean> {
  // A simulator/emulator has no push transport — Expo cannot mint a token for it. This is a fact about
  // the device, not an error, so it is reported rather than thrown. It is also why the live smoke for
  // this feature has to run on real hardware.
  if (!Device.isDevice) {
    console.warn('[push] Not a physical device — Expo push tokens are unavailable here.');
    return false;
  }

  const permitted = await ensureNotificationPermission();
  if (!permitted) {
    console.warn('[push] Notification permission denied — approval prompts will not be delivered.');
    return false;
  }

  try {
    await registerEmailApprovalChannel();
    await registerEmailApprovalCategory();
    const { data: expoPushToken } = await Notifications.getExpoPushTokenAsync({
      projectId: requireProjectId(),
    });
    const platform: PushPlatform = Platform.OS === 'ios' ? 'ios' : 'android';
    await api.registerPushToken({ platform, expoPushToken });
    return true;
  } catch (error) {
    console.error('[push] Failed to register for approval push', error);
    return false;
  }
}
