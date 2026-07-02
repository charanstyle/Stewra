import type { ISODateString, UUID } from '../common/base';

/** Audio-only or audio+video. Chosen by the caller at initiate time. */
export type CallKind = 'audio' | 'video';
export const CALL_KINDS: ReadonlyArray<CallKind> = ['audio', 'video'];

/**
 * Lifecycle status of a call session. `initiated`→`ringing`→`accepted`→`ended` is the happy path;
 * `declined`/`missed`/`failed` are the terminal alternatives.
 */
export type CallStatus =
  | 'initiated'
  | 'ringing'
  | 'accepted'
  | 'declined'
  | 'ended'
  | 'failed'
  | 'missed';

/** Why a call ended — recorded on the session and used to render call history. */
export type CallEndReason = 'hangup' | 'declined' | 'missed' | 'failed' | 'cancelled' | 'timeout';

/** A WebRTC SDP offer/answer, relayed verbatim through the signaling server (never inspected). */
export interface RtcSessionDescription {
  readonly type: 'offer' | 'answer';
  readonly sdp: string;
}

/** A WebRTC ICE candidate, relayed verbatim through the signaling server. */
export interface RtcIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

/** A persisted call, one per initiate. Drives call history and the inline call_start/call_end markers. */
export interface CallSession {
  readonly id: UUID;
  readonly conversationId: UUID;
  readonly initiatedBy: UUID;
  readonly callType: CallKind;
  readonly status: CallStatus;
  readonly startedAt: ISODateString | null;
  readonly endedAt: ISODateString | null;
  readonly durationSec: number | null;
  readonly endReason: CallEndReason | null;
  readonly createdAt: ISODateString;
}

/** One user's participation in a call, with their live media flags. */
export interface CallParticipant {
  readonly callId: UUID;
  readonly userId: UUID;
  readonly joinedAt: ISODateString | null;
  readonly leftAt: ISODateString | null;
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
}
