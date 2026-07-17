import React, { useCallback, useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import {
  EMAIL_APPROVAL_ACTION_APPROVE,
  EMAIL_APPROVAL_ACTION_DENY,
  EMAIL_APPROVAL_CATEGORY,
} from '@stewra/shared-types';
import { api } from '../services/api';
import { registerForApprovalPush } from '../services/push';
import { navigationRef } from '../navigation/RootNavigator';
import { useAuth } from './AuthContext';

/**
 * Owns the Expo push lifecycle for a signed-in user: registers this device's token + the Approve/Deny
 * category, and routes what the user taps.
 *
 * Mounts under AuthProvider because `PUT /push/token` is behind `requireAuth` — registering before
 * there is a session would just 401. Mirrors CallProvider's shape (gate on `user`, initialize once).
 *
 * COLD START is the hard case and drives most of this file. Tapping Approve can *launch* the app, and
 * at that instant there is no navigator and no restored session — so the tap is recorded and replayed
 * once both exist, rather than dropped on the floor.
 */

/** Pull the messageId out of a notification's data without asserting a type onto untyped OS input. */
function readMessageId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  if (!('type' in data) || data.type !== EMAIL_APPROVAL_CATEGORY) return null;
  if (!('messageId' in data)) return null;
  const { messageId } = data;
  return typeof messageId === 'string' && messageId.length > 0 ? messageId : null;
}

export function PushProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user } = useAuth();
  const registeredRef = useRef(false);
  /** An Approve tap waiting for the navigator + session to exist (see COLD START above). */
  const pendingApprovalRef = useRef<string | null>(null);
  /**
   * Notification ids already acted on. The launch response is delivered BOTH by
   * `getLastNotificationResponseAsync` and by the listener, so without this a single Deny tap would
   * fire two cancel requests and a single Approve tap would double-navigate.
   */
  const handledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user || registeredRef.current) {
      return;
    }
    registeredRef.current = true;
    void registerForApprovalPush();
  }, [user]);

  /** Navigate to a recorded Approve tap, if the app is finally in a state that can show it. */
  const flushPendingApproval = useCallback((): void => {
    const messageId = pendingApprovalRef.current;
    // `user` gates this because EmailApproval is only registered on the authenticated stack —
    // navigating while signed out would target a route that does not exist yet.
    if (messageId === null || !user || !navigationRef.isReady()) {
      return;
    }
    pendingApprovalRef.current = null;
    navigationRef.navigate('EmailApproval', { messageId });
  }, [user]);

  useEffect(() => {
    flushPendingApproval();
  }, [flushPendingApproval]);

  const handleResponse = useCallback(
    (response: Notifications.NotificationResponse): void => {
      const notificationId = response.notification.request.identifier;
      if (handledRef.current.has(notificationId)) {
        return;
      }
      const messageId = readMessageId(response.notification.request.content.data);
      if (messageId === null) {
        return;
      }
      handledRef.current.add(notificationId);
      const action = response.actionIdentifier;

      if (action === EMAIL_APPROVAL_ACTION_DENY) {
        // Runs in the background — no screen, no auth check. Cancelling only discards a draft.
        // Errors are swallowed on purpose: there is no UI here to show one, a draft left pending is
        // recoverable in-app, and this must never crash a background handler.
        void api.confirmEmail(messageId, { action: 'cancel' }).catch(() => undefined);
        return;
      }

      // Approve (or a tap on the notification body) opens the biometric gate. NEVER send from here:
      // this handler has no proof a person is holding the phone, which is the entire point of the gate.
      if (
        action === EMAIL_APPROVAL_ACTION_APPROVE ||
        action === Notifications.DEFAULT_ACTION_IDENTIFIER
      ) {
        pendingApprovalRef.current = messageId;
        flushPendingApproval();
      }
    },
    [flushPendingApproval],
  );

  useEffect(() => {
    // Attached regardless of auth state: a notification can cold-start the app and the response must
    // have somewhere to land the moment it arrives.
    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);
    // The tap that LAUNCHED the app may have been delivered before this listener existed; replay it.
    // `handledRef` keeps that from double-firing with the listener.
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) handleResponse(response);
    });
    return () => sub.remove();
  }, [handleResponse]);

  return <>{children}</>;
}
