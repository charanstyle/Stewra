import React, { createContext, useContext, useEffect, useRef } from 'react';
import { callService } from '../services/call/callService';
import type { CallStatus } from '../services/call/callService';
import { voipCallService } from '../services/call/voipCallService';
import { ensureNotificationPermission } from '../services/notifications';
import { navigationRef } from '../navigation/RootNavigator';
import { useAuth } from './AuthContext';

interface CallContextValue {
  readonly hasActiveOrIncomingCall: boolean;
}

const CallContext = createContext<CallContextValue | null>(null);

function isBusyStatus(status: CallStatus): boolean {
  return status !== 'idle' && status !== 'ended';
}

/**
 * Mounts once the user is authenticated. Wires callService's socket listeners and
 * initializes the native call layer (expo-callkit-telecom via voipCallService),
 * which owns the incoming/outgoing call UI, the audio session, and VoIP push.
 *
 * The incoming-call *ringer* is the OS's now (CallKit / Core-Telecom), not a JS
 * modal — so this provider no longer renders one. Its remaining UI job is to
 * carry the callee into the full-screen Call screen once their call is answered
 * from the native UI (the caller navigates itself from ConversationScreen).
 */
export function CallProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user } = useAuth();
  const [busy, setBusy] = React.useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!user || initializedRef.current) {
      return;
    }
    initializedRef.current = true;
    // Ask for POST_NOTIFICATIONS up front — on Android 13+ an incoming call can't ring without it
    // (Core-Telecom needs to post the CallStyle notification). Fire-and-forget: init proceeds regardless.
    void ensureNotificationPermission();
    callService.ensureSignalingListeners();
    void voipCallService.initialize();
  }, [user]);

  useEffect(() => {
    const offStatus = callService.on('status', (status) => {
      setBusy(isBusyStatus(status));
      // When the callee accepts from the native call UI, callService moves to
      // 'connecting'. Bring them to the Call screen if they aren't already there
      // (the caller is already on it, so the route guard prevents a double push).
      if (status !== 'connecting') {
        return;
      }
      const active = callService.getActiveCall();
      if (!active || active.isCaller || !navigationRef.isReady()) {
        return;
      }
      if (navigationRef.getCurrentRoute()?.name === 'Call') {
        return;
      }
      navigationRef.navigate('Call', {
        conversationId: active.conversationId,
        callKind: active.callKind,
        direction: 'incoming',
        peerName: active.peer.displayName,
      });
    });
    return offStatus;
  }, []);

  return (
    <CallContext.Provider value={{ hasActiveOrIncomingCall: busy }}>
      {children}
    </CallContext.Provider>
  );
}

export function useCallContext(): CallContextValue {
  const ctx = useContext(CallContext);
  if (ctx === null) {
    throw new Error('useCallContext must be used within a CallProvider');
  }
  return ctx;
}
