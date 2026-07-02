/**
 * voipCallService (iOS) — bridges PushKit/CallKit (react-native-callkeep +
 * react-native-voip-push-notification) into the call flow so an incoming call
 * rings on the lock screen even when the app is killed. Ported from TrueTalk's
 * frontend/src/services/call/voipCallService.ts.
 *
 * Flow:
 *  - AppDelegate (the withVoipAppDelegate config plugin) registers a PushKit VoIP
 *    token and, on each VoIP push, reports the call to CallKit synchronously
 *    using `callId` (the server-minted CallSession id) as the CallKit UUID —
 *    required by iOS 13+.
 *  - This service forwards the VoIP token to the backend (platform 'ios').
 *  - CallKit then emits answer/end events; we map the UUID back to the payload
 *    and drive the normal callService flow.
 *
 * On Android this is a no-op (the foreground IncomingCallRingService owns the
 * ring); callers still invoke initialize() unconditionally.
 */
import { Platform } from 'react-native';
import RNCallKeep from 'react-native-callkeep';
import VoipPushNotification from 'react-native-voip-push-notification';
import type { CallKind } from '@stewra/shared-types';
import { api } from '../api';
import { callService } from './callService';

/** The flat payload the backend's VoIP push service sends per incoming/cancelled call. */
export interface VoipCallPushPayload {
  readonly callId: string;
  readonly conversationId: string;
  readonly callKind: CallKind;
  readonly callerName: string;
  readonly type: 'incoming_call' | 'call_cancelled';
}

interface CachedCall {
  payload: VoipCallPushPayload;
  answered: boolean;
}

function isCallKind(value: string): value is CallKind {
  return value === 'audio' || value === 'video';
}

function readStringField(source: object, key: string): string | null {
  if (!(key in source)) {
    return null;
  }
  const record: { [k in typeof key]?: unknown } = source;
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function parseVoipPayload(raw: unknown): VoipCallPushPayload | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const callId = readStringField(raw, 'callId');
  if (!callId) {
    return null;
  }
  const conversationId = readStringField(raw, 'conversationId') ?? '';
  const rawKind = readStringField(raw, 'callKind') ?? 'audio';
  const callKind: CallKind = isCallKind(rawKind) ? rawKind : 'audio';
  const callerName = readStringField(raw, 'callerName') ?? 'Incoming call';
  const rawType = readStringField(raw, 'type') ?? 'incoming_call';
  const type: VoipCallPushPayload['type'] = rawType === 'call_cancelled' ? 'call_cancelled' : 'incoming_call';
  return { callId, conversationId, callKind, callerName, type };
}

class VoipCallService {
  private initialized = false;
  private readonly callsByUuid = new Map<string, CachedCall>();
  // UUIDs ended by a "call cancelled" push: the resulting CallKit endCall event
  // is a dismissal and must NOT post a decline to the backend.
  private readonly cancelledUuids = new Set<string>();

  async initialize(): Promise<void> {
    if (Platform.OS !== 'ios' || this.initialized) {
      return;
    }
    try {
      await RNCallKeep.setup({
        ios: {
          appName: 'Stewra',
          supportsVideo: true,
        },
        android: {
          alertTitle: '',
          alertDescription: '',
          cancelButton: '',
          okButton: '',
          additionalPermissions: [],
        },
      });

      this.registerCallKeepListeners();
      this.registerVoipListeners();

      // When our own flow ends, clear any lingering OS call UI.
      callService.on('ended', () => this.endActiveCallKitCalls());

      VoipPushNotification.registerVoipToken();
      this.initialized = true;
    } catch {
      // Degrade gracefully: the socket-based call flow still works without CallKit.
    }
  }

  private registerVoipListeners(): void {
    VoipPushNotification.addEventListener('register', (token: string) => {
      void api.registerCallPushToken({ platform: 'ios', voipToken: token }).catch(() => {});
    });

    VoipPushNotification.addEventListener('didLoadWithEvents', (events) => {
      for (const event of events) {
        if (
          event.name === VoipPushNotification.RNVoipPushRemoteNotificationsRegisteredEvent &&
          typeof event.data === 'string'
        ) {
          void api.registerCallPushToken({ platform: 'ios', voipToken: event.data }).catch(() => {});
        } else if (event.name === VoipPushNotification.RNVoipPushRemoteNotificationReceivedEvent) {
          this.handleVoipPayload(event.data);
        }
      }
    });

    VoipPushNotification.addEventListener('notification', (payload) => {
      this.handleVoipPayload(payload);
    });
  }

  private registerCallKeepListeners(): void {
    RNCallKeep.addEventListener('didDisplayIncomingCall', (event) => {
      if (event.error) {
        return;
      }
      this.cachePayload(event.payload, event.callUUID);
    });

    RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
      this.handleAnswer(callUUID);
    });

    RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
      this.handleEnd(callUUID);
    });
  }

  private handleVoipPayload(raw: unknown): void {
    const payload = parseVoipPayload(raw);
    if (!payload) {
      return;
    }
    if (payload.type === 'call_cancelled') {
      this.cancelledUuids.add(payload.callId);
      RNCallKeep.endCall(payload.callId);
      this.callsByUuid.delete(payload.callId);
      return;
    }
    this.cachePayload(raw, payload.callId);

    // Adopt immediately: the killed-app cold-start socket path may not have
    // (re)delivered CALL_INCOMING by the time CallKit's UI is up.
    callService.adoptIncoming({
      callId: payload.callId,
      conversationId: payload.conversationId,
      callKind: payload.callKind,
      peer: { id: '', displayName: payload.callerName },
    });
  }

  private cachePayload(raw: unknown, fallbackUuid?: string): void {
    const payload = parseVoipPayload(raw);
    if (!payload) {
      return;
    }
    const uuid = payload.callId || fallbackUuid;
    if (!uuid) {
      return;
    }
    if (!this.callsByUuid.has(uuid)) {
      this.callsByUuid.set(uuid, { payload, answered: false });
    }
  }

  private handleAnswer(callUUID: string): void {
    const cached = this.callsByUuid.get(callUUID);
    if (!cached) {
      return;
    }
    cached.answered = true;
    void callService.acceptIncoming().catch(() => {});
  }

  private handleEnd(callUUID: string): void {
    // A cancel push already ended this call; the CallKit endCall is just the
    // dismissal, so don't decline it again.
    if (this.cancelledUuids.delete(callUUID)) {
      return;
    }
    const cached = this.callsByUuid.get(callUUID);
    if (!cached) {
      return;
    }
    this.callsByUuid.delete(callUUID);
    if (cached.answered) {
      callService.hangup('hangup');
    } else {
      callService.declineIncoming('declined');
    }
  }

  private endActiveCallKitCalls(): void {
    for (const uuid of this.callsByUuid.keys()) {
      RNCallKeep.endCall(uuid);
    }
    this.callsByUuid.clear();
    this.cancelledUuids.clear();
  }
}

export const voipCallService = new VoipCallService();
export default voipCallService;
