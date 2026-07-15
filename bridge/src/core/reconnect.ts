import { DisconnectReason } from '@whiskeysockets/baileys';
import type { BridgeWaState } from '@stewra/shared-types';

/** Backoff shape for an ordinary, recoverable drop (a flaky wifi, a WhatsApp hiccup). */
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;

/**
 * A `connectionReplaced` is WhatsApp saying "another client took this session". Reconnecting immediately
 * makes the two clients fight over it, each kicking the other off forever — the reconnect storm that is
 * one of the surest ways to get an account flagged. So we back off HARD and give up quickly.
 */
const REPLACED_DELAY_MS = 5 * 60 * 1000;
const MAX_REPLACED_ATTEMPTS = 3;

/** What to do after WhatsApp closed the socket. */
export type ReconnectDecision =
  | { readonly kind: 'reconnect'; readonly delayMs: number; readonly countsAsAttempt: boolean }
  | {
      readonly kind: 'stop';
      readonly waState: BridgeWaState;
      /** Whether the local WhatsApp session is dead and must be deleted from this machine. */
      readonly wipeCredentials: boolean;
      /** Shown to the user. They are owed the real reason, especially when it is the bad one. */
      readonly message: string;
    };

export interface ReconnectInput {
  /** The Boom status code Baileys reports, or undefined when the socket just died. */
  readonly statusCode: number | undefined;
  /** How many ordinary reconnects we have already burned in this run. */
  readonly attempt: number;
  /** How many times WhatsApp has told us the session was taken over. */
  readonly replacedAttempt: number;
}

/**
 * The disconnect table.
 *
 * Baileys' README suggests `shouldReconnect = statusCode !== DisconnectReason.loggedOut`. Do NOT do that.
 * That one-liner reconnects into a bad session, into a takeover fight, and into a ban — it is the naive
 * version that gets people's accounts killed, and the account in question belongs to a user who trusted us
 * with it. Every branch below is a case where "just reconnect" is the wrong answer.
 *
 * Pure and deterministic given `random`, so the whole table is a unit test rather than a thing we find out
 * about in production.
 */
export function decideReconnect(input: ReconnectInput, random: () => number = Math.random): ReconnectDecision {
  const { statusCode, attempt, replacedAttempt } = input;

  switch (statusCode) {
    // The user (or their phone) unlinked us. The session is gone and no amount of retrying brings it back.
    case DisconnectReason.loggedOut:
      return {
        kind: 'stop',
        waState: 'logged_out',
        wipeCredentials: true,
        message: 'WhatsApp signed this device out. Link Stewra Bridge again to reconnect.',
      };

    // The stored session is corrupt. Reconnecting with it just re-fails, noisily, forever.
    case DisconnectReason.badSession:
      return {
        kind: 'stop',
        waState: 'logged_out',
        wipeCredentials: true,
        message: 'This WhatsApp session is no longer valid. Link Stewra Bridge again to reconnect.',
      };

    // The outcome the user was warned about. It gets its own state and its own words — never softened into
    // a generic "disconnected", because that would hide from them the exact thing they consented to risk.
    case DisconnectReason.forbidden:
      return {
        kind: 'stop',
        waState: 'banned',
        wipeCredentials: true,
        message:
          'WhatsApp has banned this account. This is the risk you accepted when you linked it, and it is usually not reversible. Stewra cannot undo it.',
      };

    // WhatsApp asked us to restart the socket. Expected, not a failure — so it must not eat an attempt.
    case DisconnectReason.restartRequired:
      return { kind: 'reconnect', delayMs: 0, countsAsAttempt: false };

    case DisconnectReason.connectionReplaced:
      if (replacedAttempt >= MAX_REPLACED_ATTEMPTS) {
        return {
          kind: 'stop',
          waState: 'disconnected',
          wipeCredentials: false,
          message:
            'Another WhatsApp Web client keeps taking over this session. Stewra Bridge has stopped rather than fight it — close the other client, then start the bridge again.',
        };
      }
      return { kind: 'reconnect', delayMs: REPLACED_DELAY_MS, countsAsAttempt: false };

    default:
      break;
  }

  // Everything else — connectionLost, connectionClosed, timedOut, an unknown code, a socket that just
  // died — is treated as transient, with full-jitter exponential backoff so a WhatsApp outage does not
  // turn every bridge in the world into a synchronised retry stampede.
  if (attempt >= MAX_ATTEMPTS) {
    return {
      kind: 'stop',
      waState: 'disconnected',
      wipeCredentials: false,
      message: 'Stewra Bridge could not reconnect to WhatsApp. Check your connection and start it again.',
    };
  }

  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return { kind: 'reconnect', delayMs: Math.floor(random() * ceiling), countsAsAttempt: true };
}
