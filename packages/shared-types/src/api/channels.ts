import type { BridgeDevice } from '../models/channel';
import type { ISODateString } from '../common/base';

/**
 * The experimental `whatsapp_personal` channel: linking the user's OWN WhatsApp account through the
 * Stewra Bridge app running on their own computer.
 *
 * The consent sentence and its normalizer live HERE, in shared types, for one reason: the web UI must
 * display, and the server must verify, the same words under the same rules. If the copy lived in the
 * frontend and the check lived in the backend, the two would drift, and we would end up enforcing a
 * promise the user was never actually shown.
 */

/**
 * Bump when the WORDING below changes in a way that alters what the user is agreeing to. Devices stamp
 * the version they were paired under, so a later change to the sentence never silently re-attributes a
 * new promise to someone who only ever agreed to the old one.
 */
export const WHATSAPP_PERSONAL_CONSENT_VERSION = 1;

/**
 * The user types this, by hand, to enable the channel. A checkbox is not enough, and that is the whole
 * point: the cost of being wrong here is a permanently banned WhatsApp account, and a phone number is
 * often the user's identity for bank codes and 2FA. The friction IS the feature — never soften it into
 * a click.
 */
export const WHATSAPP_PERSONAL_CONSENT_SENTENCE =
  'I understand my WhatsApp account can be permanently banned';

/**
 * How BOTH sides compare the typed sentence. Forgiving about what a human gets wrong without changing
 * meaning (casing, stray whitespace, a trailing full stop); strict about everything else — they must
 * still have typed the actual words.
 */
export function normalizeConsentSentence(input: string): string {
  return input.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '').toLowerCase();
}

/** True when `typed` is an acceptable rendering of the current consent sentence. */
export function isConsentSentenceValid(typed: string): boolean {
  return (
    normalizeConsentSentence(typed) === normalizeConsentSentence(WHATSAPP_PERSONAL_CONSENT_SENTENCE)
  );
}

/** POST /channels/whatsapp-personal/consent — the typed acknowledgement, re-verified server-side. */
export interface GrantWhatsappPersonalConsentRequest {
  /** Exactly what the user typed. The SERVER re-checks it; a client "I confirmed" boolean is worthless. */
  readonly sentence: string;
}

export interface GrantWhatsappPersonalConsentResponse {
  readonly version: number;
  readonly consentedAt: ISODateString;
}

/**
 * POST /channels/whatsapp-personal/pair — mint a single-use code the user types into the bridge app.
 * Only mintable by a user who ALREADY holds a current-version consent, so possession of a live code is
 * itself proof of consent by the time the bridge redeems it.
 */
export interface StartBridgePairingResponse {
  readonly code: string;
  readonly expiresAt: ISODateString;
  /** Where to get the app. Config-driven — never a hardcoded URL in a client. */
  readonly downloadUrl: string;
}

/**
 * POST /channels/whatsapp-personal/bridge-token — redeemed BY THE BRIDGE APP, not by the web client.
 * The pairing code is the only credential the bridge holds at this point, and it is burned on redemption.
 */
export interface ClaimBridgeTokenRequest {
  readonly code: string;
  /** What to call this device in the user's device list, e.g. "Robin's MacBook". */
  readonly deviceName: string;
  /** The bridge's own version, so the server can refuse a build too old to be safe to run. */
  readonly appVersion: string;
}

export interface ClaimBridgeTokenResponse {
  /** Returned exactly ONCE. Hashed at rest server-side, so we cannot ever show it again. */
  readonly token: string;
  readonly device: BridgeDevice;
}

export interface ListBridgeDevicesResponse {
  readonly devices: readonly BridgeDevice[];
}

/** DELETE /channels/whatsapp-personal/devices/:id — kills that device's token immediately. */
export interface RevokeBridgeDeviceResponse {
  readonly revoked: boolean;
}

/**
 * GET /channels/whatsapp-personal — everything the "Your sources" panel needs to render itself,
 * including whether the feature is even switched on for this deploy.
 */
export interface GetWhatsappPersonalResponse {
  readonly enabled: boolean;
  /** Null until the user has typed the sentence; stale if the version has since been bumped. */
  readonly consentVersion: number | null;
  readonly currentConsentVersion: number;
  readonly devices: readonly BridgeDevice[];
  readonly downloadUrl: string;
}
