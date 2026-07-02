/**
 * callService — orchestrates a single 1:1 call. It is the bridge between the
 * socket signaling relay (`socket.ts`) and the WebRTC engine (`webrtcService`),
 * and exposes a small typed event emitter the call UI (CallContext / CallScreen)
 * subscribes to. Ported from TrueTalk's frontend/src/services/call/callService.ts
 * and adapted to Stewra's contract: the server (not the client) mints the
 * `callId` via the CALL_INITIATE ack, and `CALL_INCOMING` only carries
 * `fromUserId` (the caller resolves the peer's display name from its contacts).
 *
 * Call lifecycle (caller = initiator):
 *   caller  startOutgoing() → CALL_INITIATE (ack: call) ─────────▶ backend
 *   callee  ◀── CALL_INCOMING → onIncoming → acceptIncoming() → CALL_ANSWER ──▶
 *   caller  ◀── CALL_ANSWERED → createOffer → CALL_OFFER ────────────────────▶
 *   callee  ◀── CALL_REMOTE_OFFER → acceptRemoteOffer → CALL_ANSWER_SDP ─────▶
 *   caller  ◀── CALL_REMOTE_ANSWER → applyRemoteAnswer
 *   both    ◀── CALL_REMOTE_ICE_CANDIDATE → addRemoteCandidate (until connected)
 *   either  hangup()/decline() → CALL_END/CALL_DECLINE → both teardown
 */
import type { MediaStream } from 'react-native-webrtc';
import { CLIENT_EVENTS, SERVER_EVENTS } from '@stewra/shared-types';
import type { CallEndReason, CallKind } from '@stewra/shared-types';
import { api } from '../api';
import { connectSocket, ensureSocketConnected, getSocket } from '../socket';
import { webrtcService } from './webrtcService';

/** Minimal identity of the other party, for rendering the call UI. */
export interface CallPeerInfo {
  readonly id: string;
  readonly displayName: string;
}

export interface IncomingCallInfo {
  readonly callId: string;
  readonly conversationId: string;
  readonly callKind: CallKind;
  readonly peer: CallPeerInfo;
}

export type CallStatus =
  | 'idle'
  | 'outgoing' // caller is ringing the callee
  | 'incoming' // callee is being rung
  | 'connecting' // answered, negotiating SDP/ICE
  | 'active' // media flowing
  | 'ended';

interface ActiveCall {
  callId: string;
  conversationId: string;
  callKind: CallKind;
  peer: CallPeerInfo;
  isCaller: boolean;
  answered: boolean;
}

interface CallEventMap {
  incoming: IncomingCallInfo;
  status: CallStatus;
  localStream: MediaStream;
  remoteStream: MediaStream;
  connectionState: string;
  ended: { reason: CallEndReason };
  error: { message: string };
}

type CallEventName = keyof CallEventMap;
type CallListener<K extends CallEventName> = (payload: CallEventMap[K]) => void;

/** Resolves a userId to a display name — supplied by CallContext from the contacts cache. */
export type PeerResolver = (userId: string) => string;

class CallService {
  private active: ActiveCall | null = null;
  private status: CallStatus = 'idle';
  // An incoming call can arrive (socket or CallKit/VoIP push cold start) before
  // the CallContext provider mounts and subscribes. Buffer the latest unconsumed
  // one so the modal still appears once a subscriber exists.
  private pendingIncoming: IncomingCallInfo | null = null;
  private peerResolver: PeerResolver = (userId) => userId;
  private listenersRegistered = false;

  private readonly listeners: { [K in CallEventName]: Set<CallListener<K>> } = {
    incoming: new Set<CallListener<'incoming'>>(),
    status: new Set<CallListener<'status'>>(),
    localStream: new Set<CallListener<'localStream'>>(),
    remoteStream: new Set<CallListener<'remoteStream'>>(),
    connectionState: new Set<CallListener<'connectionState'>>(),
    ended: new Set<CallListener<'ended'>>(),
    error: new Set<CallListener<'error'>>(),
  };

  /** Supply a way to turn a `fromUserId` into a display name (from the contacts cache). */
  setPeerResolver(resolver: PeerResolver): void {
    this.peerResolver = resolver;
  }

  // === Public typed event emitter ===

  on<K extends CallEventName>(event: K, listener: CallListener<K>): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  private emit<K extends CallEventName>(event: K, payload: CallEventMap[K]): void {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }

  private setStatus(status: CallStatus): void {
    this.status = status;
    this.emit('status', status);
  }

  getStatus(): CallStatus {
    return this.status;
  }

  getActiveCall(): ActiveCall | null {
    return this.active;
  }

  isInCall(): boolean {
    return this.active !== null;
  }

  /** Consume a buffered incoming call (cold-start race). One-shot. */
  consumePendingIncoming(): IncomingCallInfo | null {
    const pending = this.pendingIncoming;
    this.pendingIncoming = null;
    return pending;
  }

  getLocalStream(): MediaStream | null {
    return webrtcService.getLocalStream();
  }

  getRemoteStream(): MediaStream | null {
    return webrtcService.getRemoteStream();
  }

  /** Wire the socket listeners once. Safe to call repeatedly. */
  ensureSignalingListeners(): void {
    if (this.listenersRegistered) {
      return;
    }
    this.listenersRegistered = true;
    void connectSocket().then(() => this.registerSignalingListeners());
  }

  // === Public call control ===

  /** Caller side: ring the conversation's counterpart. */
  async startOutgoing(args: {
    conversationId: string;
    callKind: CallKind;
    peer: CallPeerInfo;
  }): Promise<void> {
    if (this.active) {
      throw new Error('Already in a call');
    }
    const connected = await ensureSocketConnected();
    const socket = getSocket();
    if (!connected || !socket) {
      this.teardown('failed');
      throw new Error('No connection to the calling service. Check your network and try again.');
    }

    await this.prepareMedia(args.callKind);

    const ack = await new Promise<{ ok: boolean; callId?: string; error?: string }>((resolve) => {
      socket.emit(
        CLIENT_EVENTS.CALL_INITIATE,
        { conversationId: args.conversationId, callType: args.callKind },
        (response) => {
          if (response.ok && response.call) {
            resolve({ ok: true, callId: response.call.id });
          } else {
            resolve({ ok: false, error: response.error ?? 'Could not place the call.' });
          }
        },
      );
    });

    if (!ack.ok || !ack.callId) {
      this.teardown('failed');
      throw new Error(ack.error ?? 'Could not place the call. Please try again.');
    }

    this.active = {
      callId: ack.callId,
      conversationId: args.conversationId,
      callKind: args.callKind,
      peer: args.peer,
      isCaller: true,
      answered: false,
    };
    this.setStatus('outgoing');
  }

  /**
   * Adopt an incoming call discovered out-of-band — a VoIP/FCM push may deliver
   * before the socket's CALL_INCOMING does. No-op if already in a call.
   */
  adoptIncoming(info: IncomingCallInfo): void {
    if (this.active) {
      return;
    }
    this.active = {
      callId: info.callId,
      conversationId: info.conversationId,
      callKind: info.callKind,
      peer: info.peer,
      isCaller: false,
      answered: false,
    };
    this.setStatus('incoming');
    this.deliverIncoming(info);
  }

  /** Callee side: accept the current incoming call. */
  async acceptIncoming(): Promise<void> {
    const active = this.active;
    if (!active || active.isCaller) {
      return;
    }
    const connected = await ensureSocketConnected();
    const socket = getSocket();
    if (!connected || !socket) {
      this.emit('error', { message: 'No connection to the calling service.' });
      this.teardown('failed');
      return;
    }
    await this.prepareMedia(active.callKind);
    active.answered = true;
    this.setStatus('connecting');
    socket.emit(CLIENT_EVENTS.CALL_ANSWER, { callId: active.callId }, () => {
      // Ack is advisory only; CALL_REMOTE_OFFER drives the next step.
    });
  }

  /** Callee side: reject the current incoming call. */
  declineIncoming(reason: CallEndReason = 'declined'): void {
    const active = this.active;
    if (!active) {
      return;
    }
    const socket = getSocket();
    socket?.emit(CLIENT_EVENTS.CALL_DECLINE, { callId: active.callId });
    this.teardown(reason);
  }

  /** Either side: end the active/ringing call. */
  hangup(reason: CallEndReason = 'hangup'): void {
    const active = this.active;
    if (!active) {
      return;
    }
    const socket = getSocket();
    socket?.emit(CLIENT_EVENTS.CALL_END, { callId: active.callId });
    this.teardown(reason);
  }

  toggleAudio(enabled: boolean): boolean {
    return webrtcService.toggleAudio(enabled);
  }

  toggleVideo(enabled: boolean): boolean {
    return webrtcService.toggleVideo(enabled);
  }

  async switchCamera(): Promise<void> {
    await webrtcService.switchCamera();
  }

  setSpeaker(on: boolean): void {
    webrtcService.setSpeaker(on);
  }

  // === Internal: media + webrtc wiring ===

  private async prepareMedia(kind: CallKind): Promise<void> {
    const credentials = await api.getTurnCredentials();
    webrtcService.setIceServers(credentials.iceServers);
    this.wireWebrtc();
    const stream = await webrtcService.startLocalMedia(kind);
    this.emit('localStream', stream);
  }

  private wireWebrtc(): void {
    webrtcService.setLocalIceHandler((candidate) => {
      const active = this.active;
      const socket = getSocket();
      if (active && socket) {
        socket.emit(CLIENT_EVENTS.CALL_ICE_CANDIDATE, { callId: active.callId, candidate });
      }
    });
    webrtcService.setRemoteStreamHandler((stream) => {
      this.emit('remoteStream', stream);
    });
    webrtcService.setConnectionStateHandler((state) => {
      this.emit('connectionState', state);
      if (state === 'connected') {
        this.setStatus('active');
      } else if (state === 'failed') {
        this.hangup('failed');
      }
    });
  }

  private deliverIncoming(info: IncomingCallInfo): void {
    if (this.listeners.incoming.size === 0) {
      this.pendingIncoming = info;
    } else {
      this.emit('incoming', info);
    }
  }

  // === Internal: signaling listeners ===

  private registerSignalingListeners(): void {
    const socket = getSocket();
    if (!socket) {
      return;
    }

    socket.on(SERVER_EVENTS.CALL_INCOMING, (data) => {
      // Already busy → tell the caller; backend also enforces this.
      if (this.active) {
        socket.emit(CLIENT_EVENTS.CALL_DECLINE, { callId: data.callId });
        return;
      }
      const info: IncomingCallInfo = {
        callId: data.callId,
        conversationId: data.conversationId,
        callKind: data.callType,
        peer: { id: data.fromUserId, displayName: this.peerResolver(data.fromUserId) },
      };
      this.active = {
        callId: info.callId,
        conversationId: info.conversationId,
        callKind: info.callKind,
        peer: info.peer,
        isCaller: false,
        answered: false,
      };
      this.setStatus('incoming');
      this.deliverIncoming(info);
    });

    socket.on(SERVER_EVENTS.CALL_ANSWERED, () => {
      const active = this.active;
      if (!active || !active.isCaller) {
        return;
      }
      active.answered = true;
      this.setStatus('connecting');
      void this.createAndSendOffer();
    });

    socket.on(SERVER_EVENTS.CALL_DECLINED, () => {
      this.teardown('declined');
    });

    socket.on(SERVER_EVENTS.CALL_ENDED, (data) => {
      this.teardown(data.reason);
    });

    socket.on(SERVER_EVENTS.CALL_REMOTE_OFFER, (data) => {
      void this.handleRemoteOffer(data.description);
    });

    socket.on(SERVER_EVENTS.CALL_REMOTE_ANSWER, (data) => {
      void webrtcService.applyRemoteAnswer(data.description);
    });

    socket.on(SERVER_EVENTS.CALL_REMOTE_ICE_CANDIDATE, (data) => {
      void webrtcService.addRemoteCandidate(data.candidate);
    });

    socket.on(SERVER_EVENTS.CALL_ERROR, (data) => {
      this.emit('error', { message: data.message });
      this.teardown('failed');
    });
  }

  private async createAndSendOffer(): Promise<void> {
    const active = this.active;
    const socket = getSocket();
    if (!active || !socket) {
      return;
    }
    try {
      const offer = await webrtcService.createOffer();
      socket.emit(CLIENT_EVENTS.CALL_OFFER, { callId: active.callId, description: offer });
    } catch {
      this.hangup('failed');
    }
  }

  private async handleRemoteOffer(
    description: Parameters<typeof webrtcService.acceptRemoteOffer>[0],
  ): Promise<void> {
    const active = this.active;
    const socket = getSocket();
    if (!active || !socket) {
      return;
    }
    try {
      const answer = await webrtcService.acceptRemoteOffer(description);
      socket.emit(CLIENT_EVENTS.CALL_ANSWER_SDP, { callId: active.callId, description: answer });
    } catch {
      this.hangup('failed');
    }
  }

  private teardown(reason: CallEndReason): void {
    const wasActive = this.active !== null;
    webrtcService.close();
    this.active = null;
    this.pendingIncoming = null;
    this.setStatus('ended');
    if (wasActive) {
      this.emit('ended', { reason });
    }
  }
}

export const callService = new CallService();
export default callService;
