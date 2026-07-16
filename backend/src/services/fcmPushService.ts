import { JWT } from 'google-auth-library';
import type { CallKind } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig';
import { logger } from '../utils/logger';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** The subset of a Google service-account JSON we need to mint FCM HTTP v1 access tokens. */
interface ServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
}

/**
 * Opaque pass-through metadata the client reads back off the incoming-call event. We ride the same
 * fields the socket incoming-call path carries so the app can route to the conversation and know the
 * call kind (voipCallService reads `conversationId` + `callKind`).
 */
export interface CallPushMetadata {
  readonly conversationId: string;
  readonly callKind: CallKind;
}

/**
 * The incoming-call event expo-callkit-telecom parses natively from the FCM data message (before JS
 * runs) to report the call to Core-Telecom.
 */
export interface IncomingCallPushEvent {
  readonly eventId: string;
  readonly serverCallId: string;
  readonly hasVideo: boolean;
  readonly startedAt: string;
  readonly caller: {
    readonly id: string;
    readonly displayName?: string;
  };
  readonly metadata?: CallPushMetadata;
}

/** Validate a parsed JSON value is a usable service account without a type assertion. */
function parseServiceAccount(raw: string): ServiceAccount {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `FCM_SERVICE_ACCOUNT_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('project_id' in value) ||
    typeof value.project_id !== 'string' ||
    !('client_email' in value) ||
    typeof value.client_email !== 'string' ||
    !('private_key' in value) ||
    typeof value.private_key !== 'string'
  ) {
    throw new Error(
      'FCM_SERVICE_ACCOUNT_JSON must contain string project_id, client_email, and private_key',
    );
  }
  return {
    project_id: value.project_id,
    client_email: value.client_email,
    private_key: value.private_key,
  };
}

/**
 * Sends background-ring pushes to Android devices via FCM HTTP v1. The push is a high-priority,
 * data-only `incomingCall` message; expo-callkit-telecom's messaging service parses it before JS is
 * running and rings full-screen over the lock screen. Auth is a service-account JWT → OAuth2 access
 * token (scope firebase.messaging) via google-auth-library; the POST uses Node's native fetch.
 *
 * All optional: when `FCM_SERVICE_ACCOUNT_JSON` is unset the service is disabled and every send is a
 * no-op (ringing degrades to the in-app socket path). A present-but-malformed value is a config error
 * and fails loud at boot rather than silently never ringing.
 */
class FcmPushService {
  private readonly projectId: string | null;
  private readonly client: JWT | null;

  constructor() {
    const raw = config.push.fcmServiceAccountJson.trim();
    if (raw.length === 0) {
      this.projectId = null;
      this.client = null;
      return;
    }
    const account = parseServiceAccount(raw);
    this.projectId = account.project_id;
    this.client = new JWT({
      email: account.client_email,
      key: account.private_key,
      scopes: [FCM_SCOPE],
    });
  }

  /** Whether background-ring pushes can be sent (i.e. a service account is configured). */
  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * Send a data-only, high-priority `incomingCall` push to each Android FCM token. Best-effort: a dead
   * or rejected token is logged and skipped; this never throws into the signaling path.
   */
  async sendIncomingCall(
    fcmTokens: ReadonlyArray<string>,
    event: IncomingCallPushEvent,
  ): Promise<void> {
    if (this.client === null || this.projectId === null || fcmTokens.length === 0) {
      return;
    }
    const { token } = await this.client.getAccessToken();
    if (!token) {
      logger.warn('FCM access token unavailable; skipping incoming-call push');
      return;
    }
    const url = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`;
    const incomingCall = JSON.stringify(event);
    await Promise.all(
      fcmTokens.map(async (fcmToken) => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token: fcmToken,
                data: { messageType: 'incomingCall', incomingCall },
                android: { priority: 'HIGH' },
              },
            }),
          });
          if (!res.ok) {
            const body = await res.text();
            logger.warn('FCM incoming-call push rejected', {
              status: res.status,
              body: body.slice(0, 300),
            });
          }
        } catch (error) {
          logger.warn('FCM incoming-call push failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }
}

export const fcmPushService = new FcmPushService();
