import { NativeModules } from 'react-native';

/**
 * Fields the native IncomingCallRingService reads from the start payload. These
 * mirror the FCM `data` keys the backend's call-push service sends for an
 * `incoming_call`, so the foreground (socket) ring and the killed-app (FCM)
 * ring behave identically — same dedup key (`callId`), same deep link, same
 * content. Ported from TrueTalk's frontend/src/services/call/incomingCallRing.ts;
 * Stewra has no avatar concept, so `callerAvatarUrl` is dropped.
 */
export interface IncomingCallRingPayload {
  readonly callId: string;
  readonly conversationId: string;
  readonly callKind: 'audio' | 'video';
  readonly callerName: string;
}

/** The currently-ringing call, as persisted natively for cold-start reads. */
export interface PendingNativeCall {
  readonly callId: string;
  readonly conversationId: string;
  readonly callKind: string;
  readonly callerName: string;
}

interface IncomingCallRingNativeModule {
  startRing(payload: IncomingCallRingPayload): void;
  stopRing(): void;
  /**
   * The call currently ringing (written natively by the foreground service), or
   * null when nothing is ringing. Used to surface the answer UI on a killed-app
   * cold start, where Android's deep-link delivery to JS is unreliable.
   */
  getPendingCall(): PendingNativeCall | null;
  /**
   * Whether the app may post a full-screen incoming-call intent. Android 14+
   * revokes USE_FULL_SCREEN_INTENT from non-calling apps by default; below 34
   * (and on iOS) this is always true.
   */
  canUseFullScreenIntent(): boolean;
  /** Open the system screen to grant full-screen-intent access (Android 14+). */
  requestFullScreenIntentPermission(): void;
}

/**
 * Bridge to the native incoming-call ring (Android foreground service). The
 * Android native module (IncomingCallRingModule) is generated into the app
 * package and registered in MainApplication by the withAndroidNotificationAvatar
 * config plugin. On iOS there is no native module — CallKit + PushKit own the
 * ring — so this falls back to a JS no-op, letting shared code call the same API
 * on both platforms without branching.
 */
const moduleCandidate: unknown = NativeModules['IncomingCallRing'];

function isNativeModule(value: unknown): value is IncomingCallRingNativeModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'startRing' in value &&
    'stopRing' in value &&
    'getPendingCall' in value
  );
}

const IncomingCallRing: IncomingCallRingNativeModule = isNativeModule(moduleCandidate)
  ? moduleCandidate
  : {
      startRing: () => {},
      stopRing: () => {},
      getPendingCall: () => null,
      // iOS / non-native: CallKit owns the ring, so full-screen access is moot.
      canUseFullScreenIntent: () => true,
      requestFullScreenIntentPermission: () => {},
    };

export default IncomingCallRing;
