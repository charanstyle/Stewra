import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { CallKind, UUID } from '@stewra/shared-types';
import { callService } from '../services/call/callService';
import type { CallState } from '../services/call/callService';
import { useSocket } from './useSocket';

interface CallContextValue {
  readonly state: CallState;
  startCall: (conversationId: UUID, callType: CallKind, peerUserId: UUID) => Promise<void>;
  answerCall: () => Promise<void>;
  declineCall: () => void;
  endCall: () => void;
  toggleAudio: () => void;
  toggleVideo: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

/**
 * Bridges the singleton `callService` state machine into React. It binds the call-signaling socket
 * listeners once a socket exists and mirrors the service's `CallState` into React state so the
 * incoming-call modal and call screen re-render on every transition.
 */
export function CallProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const socket = useSocket();
  const [state, setState] = useState<CallState>(callService.getState());

  useEffect(() => callService.subscribe(setState), []);

  useEffect(() => {
    if (socket) {
      callService.bindSocket();
    }
  }, [socket]);

  const value: CallContextValue = {
    state,
    startCall: (conversationId, callType, peerUserId) =>
      callService.startCall(conversationId, callType, peerUserId),
    answerCall: () => callService.answerCall(),
    declineCall: () => callService.declineCall(),
    endCall: () => callService.endCall(),
    toggleAudio: () => callService.toggleAudio(),
    toggleVideo: () => callService.toggleVideo(),
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (ctx === null) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return ctx;
}
