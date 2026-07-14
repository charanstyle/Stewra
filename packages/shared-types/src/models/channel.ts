import type { ISODateString, UUID } from '../common/base';

/**
 * A messaging CHANNEL is a doorway a user can reach Stewra through — not a data source.
 *
 * This is deliberately distinct from `ConnectionProvider` (see models/connection.ts), which is about
 * what Stewra can READ. Linking a channel grants Stewra no access to anything by itself: it means the
 * user can talk to their existing Stewra-AI thread from another app instead of from ours.
 *
 * `whatsapp` — the DEFAULT and RECOMMENDED path. Meta's OFFICIAL Cloud API: the user messages Stewra's
 * business number, exactly like messaging an airline. Stewra cannot read their other conversations and
 * no user's WhatsApp account is ever put at risk.
 *
 * `whatsapp_personal` — EXPERIMENTAL, opt-in, and off by default. The user links their OWN WhatsApp
 * account as a companion device. This is unofficial, against WhatsApp's terms, and the account CAN be
 * permanently banned — so it is gated behind a typed acknowledgement of exactly that. Per build-plan
 * principle 7 the companion-device client runs on the USER'S OWN MACHINE (the Stewra Bridge desktop
 * app), never on Stewra's servers: we hold no WhatsApp credentials, and users pair from their own
 * residential IP rather than from one datacenter address shared with every other user.
 *
 * The two coexist — `channel_identities` is unique on (user_id, channel), so one user may hold both.
 */
export type MessagingChannel = 'whatsapp' | 'whatsapp_personal';

/** A user's linked address on a channel. Revocable at any time (principle 7). */
export interface ChannelIdentity {
  readonly id: UUID;
  readonly channel: MessagingChannel;
  /**
   * The channel-side address, formatted for display. For WhatsApp this is the user's phone number in
   * E.164 (e.g. `+447700900123`). Safe to show the owner their own number.
   */
  readonly address: string;
  readonly createdAt: ISODateString;
}

/**
 * What the client needs to complete a link: the user sends `code` from their own WhatsApp to Stewra's
 * business number, which proves they hold BOTH the logged-in session and the phone. `deepLink` opens
 * WhatsApp with the message pre-filled so they only have to hit send.
 */
export interface ChannelLinkChallenge {
  readonly channel: MessagingChannel;
  readonly code: string;
  /** `https://wa.me/<business-number>?text=<code>` — prefilled, so linking is one tap. */
  readonly deepLink: string;
  readonly expiresAt: ISODateString;
}

/**
 * What the Stewra Bridge (the desktop app on the user's own machine) reports about its WhatsApp socket.
 * Drives the live status dot in the web UI, so the user always knows whether Stewra can actually answer.
 *
 * `logged_out` and `banned` are terminal and DISTINCT on purpose: the first means the user (or their
 * phone) unlinked us and can simply re-pair; the second means WhatsApp took the account, which is the
 * outcome they were warned about and must never be softened into a generic "disconnected".
 */
export type BridgeWaState =
  | 'disconnected'
  | 'pairing'
  | 'connecting'
  | 'open'
  | 'logged_out'
  | 'banned';

export const BRIDGE_WA_STATES: readonly BridgeWaState[] = [
  'disconnected',
  'pairing',
  'connecting',
  'open',
  'logged_out',
  'banned',
];

/**
 * One registered Stewra Bridge install — the user's own computer, holding the WhatsApp companion
 * session that Stewra's servers deliberately do not hold.
 *
 * Modelled on WhatsApp's own "Linked devices" screen, and for the same reason: the user's ability to
 * SEE every device that speaks for them and kill any of them instantly is the strongest safety property
 * in this design. The bridge's token is never included here — it is shown exactly once, at pairing.
 */
export interface BridgeDevice {
  readonly id: UUID;
  /** User-supplied, e.g. "Robin's MacBook". Shown in the device list; never trusted for anything. */
  readonly name: string;
  readonly waState: BridgeWaState;
  /** Version of the consent sentence this device was paired under (see api/channels.ts). */
  readonly consentVersion: number;
  readonly consentedAt: ISODateString;
  /** Last `bridge:hello`/heartbeat. Null until the app connects for the first time. */
  readonly lastSeenAt: ISODateString | null;
  readonly createdAt: ISODateString;
}
