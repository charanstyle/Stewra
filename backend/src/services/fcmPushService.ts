import { JWT } from 'google-auth-library';
import type { CallKind, EmailApprovalPushData } from '@stewra/shared-types';
import {
  EMAIL_APPROVAL_ANDROID_CHANNEL_ID,
  EMAIL_APPROVAL_CATEGORY,
  EMAIL_APPROVAL_PUSH_BODY,
  EMAIL_APPROVAL_PUSH_TITLE,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { logger } from '../utils/logger.js';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Per-token send result, so callers can prune the tokens FCM reports as permanently gone. */
type FcmSendOutcome = 'ok' | 'unregistered' | 'failed';

/**
 * Build the FCM `data` map for a DATA-ONLY approval push. Pure, so the exact keys the Android receiver
 * reads can be pinned in a test. The map has to be data-only (no `notification` block) for two reasons
 * that together are the whole fix for the "no Approve/Deny buttons" bug:
 *   1. Only a data-only message invokes expo-notifications' `onMessageReceived` when the app is
 *      backgrounded; a notification-type message is auto-displayed by the OS with no category attached.
 *   2. expo-notifications rebuilds the notification ENTIRELY from this map (verified against
 *      expo-notifications 55.0.24 source): `title`→title, `message`→body text, `categoryId`→the
 *      Approve/Deny category, `channelId`→the private lock-screen channel, and `body` (a JSON-object
 *      STRING) is parsed into the JS `content.data` the app reads to route (`type` + `messageId`).
 * `categoryId` lives at the top level of the data map (NOT inside `body`) because that is the key
 * `NotificationData.categoryId` reads.
 */
export function buildEmailApprovalData(payload: { messageId: string }): Record<string, string> {
  const data: EmailApprovalPushData = { type: EMAIL_APPROVAL_CATEGORY, messageId: payload.messageId };
  return {
    title: EMAIL_APPROVAL_PUSH_TITLE,
    message: EMAIL_APPROVAL_PUSH_BODY,
    body: JSON.stringify(data),
    categoryId: EMAIL_APPROVAL_CATEGORY,
    channelId: EMAIL_APPROVAL_ANDROID_CHANNEL_ID,
  };
}

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
  /** `undefined` = not resolved yet; `null` = resolved to "no service account configured". */
  private resolved: { client: JWT; projectId: string } | null | undefined;

  /**
   * Resolve the service-account client on FIRST USE, not in the constructor. The module-scope singleton
   * below is constructed the moment anything imports this file — and the WhatsApp channels import it
   * transitively (via `emailApprovalPushService`) to fire the approval prompt. Reading config in the
   * constructor would make `config.push` a load-bearing requirement of every importer; deferring the read
   * keeps the import side-effect-free (mirrors `expoPushService.client()`).
   */
  private resolve(): { client: JWT; projectId: string } | null {
    if (this.resolved === undefined) {
      const raw = config.push.fcmServiceAccountJson.trim();
      if (raw.length === 0) {
        this.resolved = null;
      } else {
        const account = parseServiceAccount(raw);
        this.resolved = {
          projectId: account.project_id,
          client: new JWT({
            email: account.client_email,
            key: account.private_key,
            scopes: [FCM_SCOPE],
          }),
        };
      }
    }
    return this.resolved;
  }

  /** Whether background-ring pushes can be sent (i.e. a service account is configured). */
  get enabled(): boolean {
    return this.resolve() !== null;
  }

  /**
   * Mint an FCM v1 OAuth2 access token paired with the project id, or null when disabled/unavailable
   * (caller no-ops).
   */
  private async auth(): Promise<{ token: string; projectId: string } | null> {
    const resolved = this.resolve();
    if (resolved === null) {
      return null;
    }
    const { token } = await resolved.client.getAccessToken();
    if (!token) {
      logger.warn('FCM access token unavailable; skipping push');
      return null;
    }
    return { token, projectId: resolved.projectId };
  }

  /**
   * POST one data-only, high-priority message to a single FCM token. Returns whether the token is still
   * live so callers can prune the ones FCM reports as permanently gone (HTTP 404 / UNREGISTERED). Never
   * throws — a transport failure is logged and reported as 'failed'.
   */
  private async postDataMessage(
    auth: { token: string; projectId: string },
    fcmToken: string,
    data: Record<string, string>,
    context: string,
  ): Promise<FcmSendOutcome> {
    const url = `https://fcm.googleapis.com/v1/projects/${auth.projectId}/messages:send`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: { token: fcmToken, data, android: { priority: 'HIGH' } },
        }),
      });
      if (res.ok) {
        return 'ok';
      }
      const body = await res.text();
      logger.warn(`FCM ${context} push rejected`, { status: res.status, body: body.slice(0, 300) });
      // 404 = the token is no longer registered (app uninstalled / token rotated). Prune it.
      return res.status === 404 ? 'unregistered' : 'failed';
    } catch (error) {
      logger.warn(`FCM ${context} push failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
  }

  /**
   * Send a data-only, high-priority `incomingCall` push to each Android FCM token. Best-effort: a dead
   * or rejected token is logged and skipped; this never throws into the signaling path.
   */
  async sendIncomingCall(
    fcmTokens: ReadonlyArray<string>,
    event: IncomingCallPushEvent,
  ): Promise<void> {
    const auth = await this.auth();
    if (auth === null || fcmTokens.length === 0) {
      return;
    }
    const data = { messageType: 'incomingCall', incomingCall: JSON.stringify(event) };
    await Promise.all(
      fcmTokens.map((fcmToken) => this.postDataMessage(auth, fcmToken, data, 'incoming-call')),
    );
  }

  /**
   * Send the DATA-ONLY approve-to-send email prompt to each Android FCM device token, returning the
   * tokens FCM reports as permanently gone so the caller can prune them. Data-only is what makes the
   * Approve/Deny buttons render when the app is backgrounded (see buildEmailApprovalData). Best-effort:
   * never throws into the WhatsApp turn that triggers it. It NEVER sends the email — approval still flows
   * through the authenticated confirm-email endpoint on the user's device.
   */
  async sendEmailApproval(fcmTokens: string[], payload: { messageId: string }): Promise<string[]> {
    const auth = await this.auth();
    if (auth === null || fcmTokens.length === 0) {
      return [];
    }
    const data = buildEmailApprovalData(payload);
    const outcomes = await Promise.all(
      fcmTokens.map(async (fcmToken) => ({
        fcmToken,
        outcome: await this.postDataMessage(auth, fcmToken, data, 'email-approval'),
      })),
    );
    return outcomes.filter((entry) => entry.outcome === 'unregistered').map((entry) => entry.fcmToken);
  }
}

export const fcmPushService = new FcmPushService();
