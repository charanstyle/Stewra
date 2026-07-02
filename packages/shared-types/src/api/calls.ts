import type { CallSession } from '../models/call';

/** One ICE server entry for an RTCPeerConnection (a TURN/STUN URL set with ephemeral credentials). */
export interface IceServerConfig {
  readonly urls: ReadonlyArray<string>;
  readonly username: string;
  readonly credential: string;
}

/**
 * Short-lived TURN credentials minted per user (RFC 5766 REST scheme). The client passes `iceServers`
 * straight into its RTCPeerConnection and refreshes before `ttlSeconds` elapses.
 */
export interface TurnCredentialsResponse {
  readonly iceServers: ReadonlyArray<IceServerConfig>;
  readonly ttlSeconds: number;
}

/** Platform for a background call-ringing push token. */
export type CallPushPlatform = 'ios' | 'android';

/**
 * Register a device's background-ring push token. iOS supplies a PushKit `voipToken`; Android supplies
 * an FCM `fcmToken`. Exactly one is expected per the `platform`.
 */
export interface RegisterCallPushTokenRequest {
  readonly platform: CallPushPlatform;
  readonly voipToken?: string;
  readonly fcmToken?: string;
}
export interface RegisterCallPushTokenResponse {
  readonly registered: true;
}

/** The caller's recent call sessions across their conversations, newest-first. */
export interface ListCallHistoryResponse {
  readonly calls: ReadonlyArray<CallSession>;
}
