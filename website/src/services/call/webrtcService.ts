import type {
  IceServerConfig,
  RtcIceCandidate,
  RtcSessionDescription,
} from '@stewra/shared-types';

/** Callbacks the engine fires up to the orchestrator (`callService`) as the peer connection evolves. */
export interface WebRtcCallbacks {
  /** A local ICE candidate to relay to the peer via the signaling server. */
  onIceCandidate: (candidate: RtcIceCandidate) => void;
  /** The remote media stream arrived (attach to an <audio>/<video> element). */
  onRemoteStream: (stream: MediaStream) => void;
  /** The connection reached a terminal failure (`failed`/`disconnected`/`closed`). */
  onConnectionFailed: () => void;
}

/**
 * A thin wrapper over a single browser `RTCPeerConnection` for a 1:1 call. It owns the local media,
 * the peer connection, and SDP/ICE plumbing; the orchestrator drives it and handles signaling. TURN is
 * force-relay (`iceTransportPolicy: 'relay'`) so a misconfigured coturn fails loud rather than silently
 * using a direct/STUN path — matching the backend's force-relay stance.
 */
export class WebRtcEngine {
  private pc: RTCPeerConnection;
  private localStream: MediaStream | null = null;
  /** ICE candidates that arrived before the remote description was set; applied once it is. */
  private pendingCandidates: RtcIceCandidate[] = [];
  private remoteDescriptionSet = false;

  constructor(
    iceServers: ReadonlyArray<IceServerConfig>,
    private readonly callbacks: WebRtcCallbacks,
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: iceServers.map((s) => ({
        urls: [...s.urls],
        username: s.username,
        credential: s.credential,
      })),
      iceTransportPolicy: 'relay',
    });

    this.pc.onicecandidate = (event): void => {
      if (event.candidate) {
        this.callbacks.onIceCandidate({
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
      }
    };

    this.pc.ontrack = (event): void => {
      const [stream] = event.streams;
      if (stream) {
        this.callbacks.onRemoteStream(stream);
      }
    };

    this.pc.onconnectionstatechange = (): void => {
      const state = this.pc.connectionState;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.callbacks.onConnectionFailed();
      }
    };
  }

  /** Acquire mic (and camera for video calls) and attach the tracks to the peer connection. */
  async acquireLocalMedia(video: boolean): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    this.localStream = stream;
    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream);
    }
    return stream;
  }

  /** Caller side: produce the SDP offer to send to the callee. */
  async createOffer(): Promise<RtcSessionDescription> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return { type: 'offer', sdp: offer.sdp ?? '' };
  }

  /** Callee side: given the caller's offer, produce the SDP answer. */
  async createAnswer(offer: RtcSessionDescription): Promise<RtcSessionDescription> {
    await this.pc.setRemoteDescription(offer);
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return { type: 'answer', sdp: answer.sdp ?? '' };
  }

  /** Caller side: apply the callee's answer to complete the negotiation. */
  async acceptAnswer(answer: RtcSessionDescription): Promise<void> {
    await this.pc.setRemoteDescription(answer);
    await this.flushPendingCandidates();
  }

  /**
   * Add a remote ICE candidate relayed from the peer. If the remote description isn't set yet the
   * candidate is buffered and applied once it is (candidates routinely race ahead of the SDP).
   */
  async addRemoteCandidate(candidate: RtcIceCandidate): Promise<void> {
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.applyCandidate(candidate);
  }

  private async flushPendingCandidates(): Promise<void> {
    this.remoteDescriptionSet = true;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      await this.applyCandidate(candidate);
    }
  }

  private async applyCandidate(candidate: RtcIceCandidate): Promise<void> {
    await this.pc.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    });
  }

  /** Toggle the local audio track; returns the resulting enabled state. */
  setAudioEnabled(enabled: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  /** Toggle the local video track (no-op for audio-only calls). */
  setVideoEnabled(enabled: boolean): void {
    for (const track of this.localStream?.getVideoTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  /** Stop all local tracks and close the peer connection. Idempotent. */
  close(): void {
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}
