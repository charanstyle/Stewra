/**
 * webrtcService — the low-level WebRTC engine for a single 1:1 call. Owns exactly
 * one RTCPeerConnection and the local capture stream. It produces/consumes the
 * strict signaling shapes from @stewra/shared-types (RtcSessionDescription /
 * RtcIceCandidate); callService relays those over the socket. The engine itself
 * never touches the socket.
 *
 * The in-call audio session is NOT managed here: `expo-callkit-telecom` owns it
 * (CallKit/Core-Telecom activate the audio session when the call is reported and
 * coordinate the LiveKit fork's RTCAudioSession). Speaker/earpiece routing is a
 * thin passthrough to `setAudioSessionPortOverride`. Media uses LiveKit's WebRTC
 * fork (`@livekit/react-native-webrtc`), which is API-identical to mainline
 * react-native-webrtc and is the engine expo-callkit-telecom coordinates with.
 *
 * Calls force-relay through Stewra's TURN (iceTransportPolicy 'relay', no public
 * STUN) so connectivity and observability run through infrastructure we control.
 */
import { setAudioSessionPortOverride } from 'expo-callkit-telecom';
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  type MediaStream,
  mediaDevices,
} from '@livekit/react-native-webrtc';
import type { CallKind, IceServerConfig, RtcSessionDescription, RtcIceCandidate } from '@stewra/shared-types';

/**
 * A local camera track on the LiveKit WebRTC fork exposes `_switchCamera()` for
 * flipping front/back (same as mainline react-native-webrtc), but the exported
 * MediaStreamTrack type doesn't declare it. Narrow to just that capability.
 */
interface SwitchableVideoTrack {
  _switchCamera: () => void;
}

function canSwitchCamera(track: object): track is SwitchableVideoTrack {
  return '_switchCamera' in track && typeof track._switchCamera === 'function';
}

/**
 * The LiveKit WebRTC fork types RTCPeerConnection's `on*` handler events as a
 * generic `Event<string>`, so the carried fields (`candidate`, `streams`) aren't
 * on the static type. Narrow to the shapes we read, without an `as` cast.
 */
interface IceCandidateEventLike {
  readonly candidate: {
    readonly candidate: string;
    readonly sdpMid: string | null;
    readonly sdpMLineIndex: number | null;
  } | null;
}
function isIceCandidateEvent(event: object): event is IceCandidateEventLike {
  return 'candidate' in event;
}

interface TrackEventLike {
  readonly streams: ReadonlyArray<MediaStream>;
}
function isTrackEvent(event: object): event is TrackEventLike {
  return 'streams' in event;
}

type LocalIceHandler = (candidate: RtcIceCandidate) => void;
type RemoteStreamHandler = (stream: MediaStream) => void;
type ConnectionStateHandler = (state: string) => void;

class WebrtcService {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private iceServers: ReadonlyArray<IceServerConfig> = [];
  private pendingRemoteCandidates: RtcIceCandidate[] = [];
  private hasRemoteDescription = false;

  private onLocalIce: LocalIceHandler | null = null;
  private onRemoteStream: RemoteStreamHandler | null = null;
  private onConnectionState: ConnectionStateHandler | null = null;

  setIceServers(servers: ReadonlyArray<IceServerConfig>): void {
    this.iceServers = servers;
    // Mid-call refresh: update the live peer's ICE server set so a long call
    // survives a TURN credential rotation (setConfiguration takes effect on the
    // next ICE restart / gathering pass; it never disrupts an already-connected
    // media path).
    if (this.pc) {
      this.pc.setConfiguration({
        iceServers: this.iceServers.map((server) => ({
          urls: [...server.urls],
          username: server.username,
          credential: server.credential,
        })),
        iceTransportPolicy: 'relay',
      });
    }
  }

  setLocalIceHandler(handler: LocalIceHandler): void {
    this.onLocalIce = handler;
  }

  setRemoteStreamHandler(handler: RemoteStreamHandler): void {
    this.onRemoteStream = handler;
  }

  setConnectionStateHandler(handler: ConnectionStateHandler): void {
    this.onConnectionState = handler;
  }

  /** Acquire mic (+camera for video). The audio session is owned by CallKit/
   *  Core-Telecom (expo-callkit-telecom), activated when the call is reported. */
  async startLocalMedia(kind: CallKind): Promise<MediaStream> {
    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video: kind === 'video' ? { facingMode: 'user' } : false,
    });
    this.localStream = stream;
    return stream;
  }

  private ensurePeer(): RTCPeerConnection {
    if (this.pc) {
      return this.pc;
    }

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers.map((server) => ({
        urls: [...server.urls],
        username: server.username,
        credential: server.credential,
      })),
      // Force-relay: never expose a peer's IP, always traverse our TURN.
      iceTransportPolicy: 'relay',
      bundlePolicy: 'max-bundle',
    });

    pc.onicecandidate = (event) => {
      if (!isIceCandidateEvent(event)) {
        return;
      }
      const candidate = event.candidate;
      if (candidate && this.onLocalIce) {
        this.onLocalIce({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        });
      }
    };

    pc.ontrack = (event) => {
      if (!isTrackEvent(event)) {
        return;
      }
      const [stream] = event.streams;
      if (stream) {
        this.remoteStream = stream;
        if (this.onRemoteStream) {
          this.onRemoteStream(stream);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.onConnectionState) {
        this.onConnectionState(pc.connectionState);
      }
    };

    const localStream = this.localStream;
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    this.pc = pc;
    return pc;
  }

  /** Caller: create the SDP offer once the callee has answered. */
  async createOffer(): Promise<RtcSessionDescription> {
    const pc = this.ensurePeer();
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    return { type: 'offer', sdp: offer.sdp ?? '' };
  }

  /** Callee: apply the remote offer and produce the answer. */
  async acceptRemoteOffer(description: RtcSessionDescription): Promise<RtcSessionDescription> {
    const pc = this.ensurePeer();
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: description.type, sdp: description.sdp }),
    );
    this.hasRemoteDescription = true;
    await this.flushRemoteCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return { type: 'answer', sdp: answer.sdp ?? '' };
  }

  /** Caller: apply the callee's answer. */
  async applyRemoteAnswer(description: RtcSessionDescription): Promise<void> {
    const pc = this.ensurePeer();
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: description.type, sdp: description.sdp }),
    );
    this.hasRemoteDescription = true;
    await this.flushRemoteCandidates();
  }

  /** Buffer remote ICE until the remote description is set, then add. */
  async addRemoteCandidate(candidate: RtcIceCandidate): Promise<void> {
    if (!this.pc || !this.hasRemoteDescription) {
      this.pendingRemoteCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(
      new RTCIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      }),
    );
  }

  private async flushRemoteCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.pendingRemoteCandidates.length === 0) {
      return;
    }
    const buffered = this.pendingRemoteCandidates;
    this.pendingRemoteCandidates = [];
    for (const candidate of buffered) {
      try {
        await pc.addIceCandidate(
          new RTCIceCandidate({
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          }),
        );
      } catch {
        // A late/duplicate candidate failing to add is not fatal to the call.
      }
    }
  }

  toggleAudio(enabled: boolean): boolean {
    const stream = this.localStream;
    if (!stream) {
      return false;
    }
    for (const track of stream.getAudioTracks()) {
      track.enabled = enabled;
    }
    return enabled;
  }

  toggleVideo(enabled: boolean): boolean {
    const stream = this.localStream;
    if (!stream) {
      return false;
    }
    for (const track of stream.getVideoTracks()) {
      track.enabled = enabled;
    }
    return enabled;
  }

  async switchCamera(): Promise<void> {
    const stream = this.localStream;
    if (!stream) {
      return;
    }
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack && canSwitchCamera(videoTrack)) {
      videoTrack._switchCamera();
    }
  }

  /** Route call audio to the loudspeaker (true) or earpiece (false). CallKit/
   *  Core-Telecom own the audio session; this overrides its output port. */
  setSpeaker(on: boolean): void {
    setAudioSessionPortOverride(on);
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  /** Tear down the peer, local capture and audio session. Idempotent. */
  close(): void {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }
    this.remoteStream = null;
    this.pendingRemoteCandidates = [];
    this.hasRemoteDescription = false;
    // The audio session is torn down by expo-callkit-telecom when the call is
    // ended (endCall / reportCallEnded), so there is nothing to stop here.
  }
}

export const webrtcService = new WebrtcService();
export default webrtcService;
