/**
 * voipCallService — the system-call-UI adapter. It bridges callService's socket
 * call state to the OS call UI + audio session (expo-callkit-telecom: CallKit on
 * iOS, Jetpack Core-Telecom on Android) and back. It is a pure adapter: it
 * subscribes to callService's event emitter and drives it via its public methods,
 * so callService never imports this module (no dependency cycle).
 *
 * Two directions:
 *   callService → OS  (mirror our socket call into the native UI + audio session)
 *     • outgoing call started  → startOutgoingCall
 *     • socket CALL_INCOMING   → reportIncomingCall (shows the native ringer)
 *     • media connected        → reportOutgoingCallConnected / fulfillIncomingCallConnected
 *     • call ended             → endCall (dismiss native UI)
 *   OS → callService  (native buttons + cold-start push drive our flow)
 *     • user answers on OS UI  → callService.acceptIncoming
 *     • user ends/declines     → callService.hangup / declineIncoming
 *     • native mute button     → callService.toggleAudio
 *     • push cold-start        → a CallSession appears with an incomingCallEvent
 *                                parsed natively before JS ran; adopt it
 *
 * VoIP push token registration also lives here (registerVoIPPush + token → backend).
 */
import { randomUUID } from 'expo-crypto';
import {
  addCallAnsweredListener,
  addCallEndedListener,
  addCallSessionAddedListener,
  addOutgoingCallStartedListener,
  addSetMutedActionListener,
  addVoIPPushTokenUpdatedListener,
  endCall,
  fulfillIncomingCallConnected,
  getActiveCallSession,
  getVoIPPushToken,
  registerVoIPPush,
  reportIncomingCall,
  reportOutgoingCallConnected,
  startOutgoingCall,
  type CallSession,
  type VoIPPushToken,
} from 'expo-callkit-telecom';
import type { CallKind } from '@stewra/shared-types';
import { api } from '../api';
import { callService } from './callService';

/**
 * The metadata we ride into (and read back out of) an IncomingCallEvent. The lib
 * treats it as an opaque pass-through, so we narrow the specific keys we own with
 * literal-key guards rather than trusting a shape.
 */
function readMetaConversationId(meta: unknown): string | undefined {
  if (typeof meta === 'object' && meta !== null && 'conversationId' in meta) {
    const value = meta.conversationId;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function readMetaCallKind(meta: unknown): CallKind | undefined {
  if (typeof meta === 'object' && meta !== null && 'callKind' in meta) {
    const value = meta.callKind;
    if (value === 'audio' || value === 'video') {
      return value;
    }
  }
  return undefined;
}

class VoipCallService {
  private initialized = false;

  // The OS-assigned CallSession id for the current call (distinct from our
  // server callId), needed to end/connect the native side. One call at a time.
  private systemCallId: string | null = null;
  // requestId from the answered event; required to ack incoming-call connection.
  private incomingRequestId: string | null = null;
  // The server callId we've already surfaced to the OS, so a socket-incoming
  // report and the resulting session-added event don't double-report/adopt.
  private reportedServerCallId: string | null = null;
  // True while WE are ending the native call (callService drove it), so the
  // resulting CallEnded event isn't mistaken for a user-initiated OS hang-up.
  private appInitiatedEnd = false;
  // True once we've acked the media connection for the current call.
  private connectedReported = false;

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    this.registerCallServiceListeners();
    this.registerOsListeners();

    // Register for VoIP push (PushKit on iOS, FCM on Android) and forward the
    // token to the backend. Both the immediately-available token and later
    // refreshes are sent.
    try {
      registerVoIPPush();
      const existing = await getVoIPPushToken();
      if (existing) {
        this.sendPushToken(existing);
      }
    } catch {
      // Degrade gracefully: the socket call flow still rings while foregrounded.
    }

    // A push may have cold-started the app and reported a call natively before
    // these listeners attached — hydrate any already-active session.
    try {
      const active = await getActiveCallSession();
      if (active) {
        this.onSessionAppeared(active);
      }
    } catch {
      // No active session to adopt.
    }
  }

  private sendPushToken(voip: VoIPPushToken): void {
    const body =
      voip.type === 'FCM'
        ? { platform: 'android' as const, fcmToken: voip.token }
        : { platform: 'ios' as const, voipToken: voip.token };
    void api.registerCallPushToken(body).catch(() => {});
  }

  // === callService → OS ===

  private registerCallServiceListeners(): void {
    callService.on('status', (status) => {
      const active = callService.getActiveCall();
      if (status === 'outgoing' && active?.isCaller) {
        this.startOsOutgoing(active.peer.id, active.peer.displayName, active.callKind);
      } else if (status === 'active' && !this.connectedReported) {
        this.reportConnected();
      }
    });

    callService.on('incoming', (info) => {
      // Only report a socket-incoming call the OS doesn't already know about
      // (a push cold-start already has a native session for it).
      if (this.reportedServerCallId === info.callId) {
        return;
      }
      this.reportedServerCallId = info.callId;
      void reportIncomingCall({
        eventId: randomUUID(),
        serverCallId: info.callId,
        hasVideo: info.callKind === 'video',
        startedAt: new Date().toISOString(),
        caller: {
          id: info.peer.id || info.callId,
          displayName: info.peer.displayName,
        },
        metadata: { conversationId: info.conversationId, callKind: info.callKind },
      }).catch(() => {});
    });

    callService.on('ended', () => {
      this.endOsCall();
    });
  }

  private startOsOutgoing(peerId: string, displayName: string, kind: CallKind): void {
    void startOutgoingCall(
      { id: peerId || displayName, displayName },
      { hasVideo: kind === 'video' },
    ).catch(() => {});
  }

  private reportConnected(): void {
    const active = callService.getActiveCall();
    if (!active) {
      return;
    }
    this.connectedReported = true;
    if (active.isCaller && this.systemCallId) {
      void reportOutgoingCallConnected(this.systemCallId).catch(() => {});
    } else if (!active.isCaller && this.incomingRequestId) {
      void fulfillIncomingCallConnected(this.incomingRequestId).catch(() => {});
    }
  }

  /** Dismiss the native call UI because our own flow ended. Idempotent. */
  private endOsCall(): void {
    const id = this.systemCallId;
    this.resetCallState();
    if (id) {
      this.appInitiatedEnd = true;
      void endCall(id).catch(() => {
        this.appInitiatedEnd = false;
      });
    }
  }

  private resetCallState(): void {
    this.systemCallId = null;
    this.incomingRequestId = null;
    this.reportedServerCallId = null;
    this.connectedReported = false;
  }

  // === OS → callService ===

  private registerOsListeners(): void {
    addCallSessionAddedListener((event) => {
      this.onSessionAppeared(event.session);
    });

    addOutgoingCallStartedListener((event) => {
      this.systemCallId = event.id;
    });

    addCallAnsweredListener((event) => {
      this.systemCallId = event.id;
      this.incomingRequestId = event.requestId ?? null;
      void callService.acceptIncoming().catch(() => {});
    });

    addCallEndedListener(() => {
      // The native call is over. Clear the id first so callService's resulting
      // 'ended' event can't loop back into endOsCall().
      const wasAppInitiated = this.appInitiatedEnd;
      this.resetCallState();
      this.appInitiatedEnd = false;
      if (wasAppInitiated) {
        return; // We asked for this end; nothing more to drive.
      }
      // User ended/declined from the native UI → drive our flow to match.
      const active = callService.getActiveCall();
      if (!active) {
        return;
      }
      if (active.answered) {
        callService.hangup('hangup');
      } else {
        callService.declineIncoming('declined');
      }
    });

    addSetMutedActionListener((event) => {
      callService.toggleAudio(!event.isMuted);
    });

    addVoIPPushTokenUpdatedListener((event) => {
      if (event.token) {
        this.sendPushToken({ token: event.token, type: event.type });
      }
    });
  }

  /**
   * A CallSession appeared — either from our own reportIncomingCall (already
   * tracked) or, on a push cold-start, parsed natively before JS ran. In the
   * cold-start case callService has no active call yet, so adopt it from the
   * session's incomingCallEvent.
   */
  private onSessionAppeared(session: CallSession): void {
    this.systemCallId = session.id;
    const event = session.incomingCallEvent;
    if (!event) {
      return; // Outgoing or no push payload; nothing to adopt.
    }
    if (callService.isInCall() || this.reportedServerCallId === event.serverCallId) {
      this.reportedServerCallId = event.serverCallId;
      return; // Already surfaced via the socket path.
    }
    this.reportedServerCallId = event.serverCallId;
    const callKind = readMetaCallKind(event.metadata) ?? (event.hasVideo ? 'video' : 'audio');
    callService.adoptIncoming({
      callId: event.serverCallId,
      conversationId: readMetaConversationId(event.metadata) ?? '',
      callKind,
      peer: { id: event.caller.id, displayName: event.caller.displayName ?? 'Incoming call' },
    });
  }
}

export const voipCallService = new VoipCallService();
export default voipCallService;
