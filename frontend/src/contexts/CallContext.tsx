import React, { createContext, useContext, useEffect, useRef } from 'react';
import type { IncomingCallInfo } from '../services/call/callService';
import { callService } from '../services/call/callService';
import { voipCallService } from '../services/call/voipCallService';
import { adoptPendingAndroidCall, registerAndroidCallPushToken } from '../services/call/androidPushToken';
import { navigationRef } from '../navigation/RootNavigator';
import { useAuth } from './AuthContext';
import IncomingCallModal from '../components/IncomingCallModal';

interface CallContextValue {
  readonly hasActiveOrIncomingCall: boolean;
}

const CallContext = createContext<CallContextValue | null>(null);

/**
 * Mounts once the user is authenticated. Wires callService's socket listeners,
 * initializes CallKit/PushKit on iOS, and renders the global incoming-call modal
 * (independent of whatever screen is currently focused). Accepting a call
 * navigates to the full-screen Call screen.
 */
export function CallProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user } = useAuth();
  const [incoming, setIncoming] = React.useState<IncomingCallInfo | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!user || initializedRef.current) {
      return;
    }
    initializedRef.current = true;
    callService.ensureSignalingListeners();
    void voipCallService.initialize();
    void registerAndroidCallPushToken();
    adoptPendingAndroidCall();

    const pending = callService.consumePendingIncoming();
    if (pending) {
      setIncoming(pending);
    }
  }, [user]);

  useEffect(() => {
    const offIncoming = callService.on('incoming', (info) => {
      setIncoming(info);
    });
    const offEnded = callService.on('ended', () => {
      setIncoming(null);
    });
    return () => {
      offIncoming();
      offEnded();
    };
  }, []);

  const handleAccept = (): void => {
    if (!incoming) {
      return;
    }
    const { conversationId, callKind, peer } = incoming;
    setIncoming(null);
    void callService.acceptIncoming();
    if (navigationRef.isReady()) {
      navigationRef.navigate('Call', {
        conversationId,
        callKind,
        direction: 'incoming',
        peerName: peer.displayName,
      });
    }
  };

  const handleDecline = (): void => {
    callService.declineIncoming('declined');
    setIncoming(null);
  };

  return (
    <CallContext.Provider value={{ hasActiveOrIncomingCall: incoming !== null }}>
      {children}
      {incoming ? (
        <IncomingCallModal info={incoming} onAccept={handleAccept} onDecline={handleDecline} />
      ) : null}
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
