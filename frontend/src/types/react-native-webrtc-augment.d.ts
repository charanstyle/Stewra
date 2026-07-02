/**
 * react-native-webrtc ships incomplete TypeScript declarations for
 * RTCPeerConnection (missing the `on*` event-handler properties and
 * `setConfiguration`, even though they exist at runtime). This augments the
 * module's own `RTCPeerConnection` class declaration via interface merging so
 * webrtcService.ts can use the standard WebRTC event-handler API without an
 * `any`/`as` escape hatch. No DOM lib is available in this project (React
 * Native has its own globals), so the event shapes below are declared locally
 * rather than reusing `lib.dom.d.ts`'s `RTCPeerConnectionIceEvent`/`RTCTrackEvent`.
 *
 * The top-level import makes this file an ES module (rather than a global
 * script), which is what makes TypeScript MERGE the `declare module` block
 * below into the package's real declarations instead of replacing them outright.
 * It also binds `MediaStream`/`RTCIceCandidate` to the package's actual exported
 * classes explicitly, rather than relying on ambient name lookup inside the
 * augmentation (which resolved to a structurally-mismatched type).
 */
import type { MediaStream as RNMediaStream, RTCIceCandidate as RNRTCIceCandidate } from 'react-native-webrtc';

declare module 'react-native-webrtc' {
  interface RTCIceCandidateEventLike {
    readonly candidate: RNRTCIceCandidate | null;
  }

  interface RTCTrackEventLike {
    readonly streams: ReadonlyArray<RNMediaStream>;
  }

  interface RTCConfigurationLike {
    readonly iceServers: ReadonlyArray<{
      readonly urls: ReadonlyArray<string>;
      readonly username?: string;
      readonly credential?: string;
    }>;
    readonly iceTransportPolicy?: 'all' | 'relay';
    readonly bundlePolicy?: 'balanced' | 'max-bundle' | 'max-compat';
  }

  interface RTCPeerConnection {
    onicecandidate: ((event: RTCIceCandidateEventLike) => void) | null;
    ontrack: ((event: RTCTrackEventLike) => void) | null;
    onconnectionstatechange: (() => void) | null;
    setConfiguration(configuration: RTCConfigurationLike): void;
  }
}
