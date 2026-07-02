import { CLIENT_EVENTS, SERVER_EVENTS } from '@stewra/shared-types';
import type { CallKind, CallSession, UUID } from '@stewra/shared-types';
import { api } from '../api';
import { getSocket } from '../socket';
import type { Ack, StewraSocket } from '../socket';
import { WebRtcEngine } from './webrtcService';

/**
 * The orchestrator's public phase. `idle` (no call) → `calling` (outgoing, ringing the callee) or
 * `incoming` (a call is ringing us) → `connecting` (media negotiating) → `active` (connected) → back to
 * `idle` once ended. Both caller and callee share this one machine.
 */
export type CallPhase = 'idle' | 'calling' | 'incoming' | 'connecting' | 'active';

/** The full observable call state pushed to subscribers (CallContext) on every transition. */
export interface CallState {
  readonly phase: CallPhase;
  readonly callId: UUID | null;
  readonly conversationId: UUID | null;
  readonly callType: CallKind;
  /** The other party's user id (callee for outgoing, caller for incoming). */
  readonly peerUserId: UUID | null;
  readonly localStream: MediaStream | null;
  readonly remoteStream: MediaStream | null;
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
  /** A terminal error/decline reason surfaced to the UI, cleared on the next call. */
  readonly error: string | null;
}

const IDLE_STATE: CallState = {
  phase: 'idle',
  callId: null,
  conversationId: null,
  callType: 'audio',
  peerUserId: null,
  localStream: null,
  remoteStream: null,
  audioEnabled: true,
  videoEnabled: true,
  error: null,
};

type Listener = (state: CallState) => void;

/**
 * Singleton call orchestrator: binds the Socket.IO signaling events to a `WebRtcEngine` and exposes an
 * observable `CallState`. Never persists — call rows are written server-side. One live 1:1 call at a
 * time (a second incoming call while busy is declined by the server with `busy`).
 */
class CallService {
  private state: CallState = IDLE_STATE;
  private engine: WebRtcEngine | null = null;
  private listeners = new Set<Listener>();
  private socket: StewraSocket | null = null;
  private bound = false;

  /** Subscribe to state changes; returns an unsubscribe fn. Immediately pushes the current state. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): CallState {
    return this.state;
  }

  /**
   * Attach the signaling listeners to the live socket. Idempotent — safe to call from an effect on
   * every mount; only binds once. Requires the user to be authenticated (socket available).
   */
  bindSocket(): void {
    if (this.bound) {
      return;
    }
    const socket = getSocket();
    if (!socket) {
      return;
    }
    this.socket = socket;
    this.bound = true;

    socket.on(SERVER_EVENTS.CALL_INCOMING, (event) => {
      // Ignore a second incoming call while already busy (the server also guards this).
      if (this.state.phase !== 'idle') {
        return;
      }
      this.setState({
        ...IDLE_STATE,
        phase: 'incoming',
        callId: event.callId,
        conversationId: event.conversationId,
        callType: event.callType,
        peerUserId: event.fromUserId,
        videoEnabled: event.callType === 'video',
      });
    });

    socket.on(SERVER_EVENTS.CALL_ANSWERED, (event) => {
      // Caller side: the callee accepted — begin media negotiation by sending our offer.
      if (this.state.callId !== event.callId) {
        return;
      }
      void this.startNegotiationAsCaller();
    });

    socket.on(SERVER_EVENTS.CALL_REMOTE_OFFER, (event) => {
      // Callee side: the caller's offer arrived — answer it.
      if (this.state.callId !== event.callId) {
        return;
      }
      void this.answerNegotiationAsCallee(event.description);
    });

    socket.on(SERVER_EVENTS.CALL_REMOTE_ANSWER, (event) => {
      if (this.state.callId !== event.callId || !this.engine) {
        return;
      }
      void this.engine.acceptAnswer(event.description);
    });

    socket.on(SERVER_EVENTS.CALL_REMOTE_ICE_CANDIDATE, (event) => {
      if (this.state.callId !== event.callId || !this.engine) {
        return;
      }
      void this.engine.addRemoteCandidate(event.candidate);
    });

    socket.on(SERVER_EVENTS.CALL_DECLINED, (event) => {
      if (this.state.callId !== event.callId) {
        return;
      }
      this.teardown('Call declined');
    });

    socket.on(SERVER_EVENTS.CALL_ENDED, (event) => {
      if (this.state.callId !== event.callId) {
        return;
      }
      this.teardown(null);
    });

    socket.on(SERVER_EVENTS.CALL_ERROR, (event) => {
      if (event.callId !== null && this.state.callId !== event.callId) {
        return;
      }
      this.teardown(event.message);
    });
  }

  /** Start an outgoing call. Rings the callee; media negotiation begins once they answer. */
  async startCall(conversationId: UUID, callType: CallKind, peerUserId: UUID): Promise<void> {
    const socket = getSocket();
    if (!socket) {
      throw new Error('Not connected');
    }
    this.bindSocket();
    this.setState({
      ...IDLE_STATE,
      phase: 'calling',
      conversationId,
      callType,
      peerUserId,
      videoEnabled: callType === 'video',
    });

    const res = await this.emitInitiate(socket, conversationId, callType);
    if (!res.ok) {
      this.teardown(res.error);
      return;
    }
    this.setState({ ...this.state, callId: res.call.id });
  }

  /** Accept the currently-ringing incoming call: acquire media, then ack the answer to the server. */
  async answerCall(): Promise<void> {
    const socket = this.socket ?? getSocket();
    if (!socket || this.state.phase !== 'incoming' || this.state.callId === null) {
      return;
    }
    this.setState({ ...this.state, phase: 'connecting' });
    await this.createEngine(this.state.callType);

    const callId = this.state.callId;
    socket.emit(CLIENT_EVENTS.CALL_ANSWER, { callId }, (res) => {
      if (!res.ok) {
        this.teardown(res.error);
      }
      // The caller's offer follows via CALL_REMOTE_OFFER, which we answer.
    });
  }

  /** Decline a ringing incoming call. */
  declineCall(): void {
    const socket = this.socket ?? getSocket();
    if (socket && this.state.callId !== null) {
      socket.emit(CLIENT_EVENTS.CALL_DECLINE, { callId: this.state.callId }, () => undefined);
    }
    this.teardown(null);
  }

  /** Hang up an active or outgoing call. */
  endCall(): void {
    const socket = this.socket ?? getSocket();
    if (socket && this.state.callId !== null) {
      socket.emit(CLIENT_EVENTS.CALL_END, { callId: this.state.callId }, () => undefined);
    }
    this.teardown(null);
  }

  toggleAudio(): void {
    const next = !this.state.audioEnabled;
    this.engine?.setAudioEnabled(next);
    this.setState({ ...this.state, audioEnabled: next });
  }

  toggleVideo(): void {
    const next = !this.state.videoEnabled;
    this.engine?.setVideoEnabled(next);
    this.setState({ ...this.state, videoEnabled: next });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async startNegotiationAsCaller(): Promise<void> {
    const socket = this.socket;
    if (!socket || this.state.callId === null) {
      return;
    }
    this.setState({ ...this.state, phase: 'connecting' });
    const engine = await this.createEngine(this.state.callType);
    const offer = await engine.createOffer();
    const callId = this.state.callId;
    socket.emit(CLIENT_EVENTS.CALL_OFFER, { callId, description: offer }, (res) => {
      if (!res.ok) {
        this.teardown(res.error);
      }
    });
  }

  private async answerNegotiationAsCallee(
    offer: Parameters<WebRtcEngine['createAnswer']>[0],
  ): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.engine || this.state.callId === null) {
      return;
    }
    const answer = await this.engine.createAnswer(offer);
    const callId = this.state.callId;
    socket.emit(CLIENT_EVENTS.CALL_ANSWER_SDP, { callId, description: answer }, (res) => {
      if (!res.ok) {
        this.teardown(res.error);
      }
    });
  }

  /** Build the WebRTC engine with fresh TURN creds and acquire local media. */
  private async createEngine(callType: CallKind): Promise<WebRtcEngine> {
    const { iceServers } = await api.getTurnCredentials();
    const engine = new WebRtcEngine(iceServers, {
      onIceCandidate: (candidate) => {
        const socket = this.socket;
        if (socket && this.state.callId !== null) {
          socket.emit(
            CLIENT_EVENTS.CALL_ICE_CANDIDATE,
            { callId: this.state.callId, candidate },
            () => undefined,
          );
        }
      },
      onRemoteStream: (stream) => {
        this.setState({ ...this.state, phase: 'active', remoteStream: stream });
      },
      onConnectionFailed: () => {
        this.teardown('Connection lost');
      },
    });
    this.engine = engine;
    const localStream = await engine.acquireLocalMedia(callType === 'video');
    this.setState({ ...this.state, localStream });
    return engine;
  }

  private emitInitiate(
    socket: StewraSocket,
    conversationId: UUID,
    callType: CallKind,
  ): Promise<Ack<{ call: CallSession }>> {
    return new Promise((resolve) => {
      socket.emit(CLIENT_EVENTS.CALL_INITIATE, { conversationId, callType }, resolve);
    });
  }

  private teardown(error: string | null): void {
    this.engine?.close();
    this.engine = null;
    this.setState({ ...IDLE_STATE, error });
  }

  private setState(next: CallState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

export const callService = new CallService();
