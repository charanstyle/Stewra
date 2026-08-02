import { DisconnectReason } from '@whiskeysockets/baileys';
import type { BridgeWaState } from '@stewra/shared-types';
import { decideReconnect } from './reconnect.js';

/**
 * How many fresh QR sessions to open before giving up. WhatsApp rotates the QR a handful of times within
 * one socket (~2 minutes) and then closes it with a 408; each round below re-opens for another ~2 minutes
 * of scanning. Past a few rounds the honest move is to stop and tell the user, not to keep re-registering
 * against WhatsApp forever.
 */
export const MAX_QR_ROUNDS = 3;

/** How long to wait before opening the next pairing socket after an unscanned QR expired. */
export const PAIRING_RETRY_DELAY_MS = 1_000;

export interface CloseInput {
  /** The Boom status code Baileys reported, or undefined when the socket just died. */
  readonly statusCode: number | undefined;
  /** Whether the on-disk credentials say a pairing has completed, evaluated at close time. */
  readonly isRegistered: boolean;
  /** True while a fresh session is showing QR codes; false once WhatsApp has been open. */
  readonly pairingActive: boolean;
  /** How many QR rounds this pairing has already burned. */
  readonly pairingAttempt: number;
  /** Ordinary-reconnect counter, passed through to the backoff table. */
  readonly attempt: number;
  /** Session-takeover counter, passed through to the backoff table. */
  readonly replacedAttempt: number;
}

/** What the shell must do after a close. Every effect is named here so the table is a unit test. */
export type CloseAction =
  /**
   * The QR on screen expired with its socket, unscanned. Wipe the PARTIAL credentials (an unscanned QR
   * half-populates them, and a plain reconnect would try to LOG IN with them and draw a terminal 401),
   * store `nextPairingAttempt`, emit 'pairing', and schedule a fresh `connect()` after `delayMs`.
   * NO `onSessionDestroyed` — there was never a session to destroy.
   */
  | { readonly kind: 'wipe-and-retry'; readonly nextPairingAttempt: number; readonly delayMs: number }
  /**
   * The QR expired `MAX_QR_ROUNDS` times over. Wipe the partial credentials (still no
   * `onSessionDestroyed`), reset `pairingActive`/`pairingAttempt`, and park with `message`.
   */
  | { readonly kind: 'pairing-give-up'; readonly message: string }
  /**
   * `decideReconnect` said stop, passed through. `wipeCredentials` true ⇒ the shell wipes AND fires
   * `onSessionDestroyed` — this one was a real session, and it is gone.
   */
  | {
      readonly kind: 'stop';
      readonly waState: BridgeWaState;
      readonly wipeCredentials: boolean;
      readonly message: string;
    }
  /** Reconnect after `delayMs`; the shell bumps the counters the two booleans name. */
  | {
      readonly kind: 'reconnect';
      readonly delayMs: number;
      readonly countsAsAttempt: boolean;
      readonly bumpReplaced: boolean;
    };

/**
 * The whole close-handling policy, pure: the pairing lifecycle layered over `decideReconnect`'s
 * disconnect table. `whatsapp.ts` extracts the status code, calls this, and applies the effects.
 *
 * A close in the middle of pairing means the QR on screen expired with the socket (WhatsApp cycles a
 * few QR refs, ~2 minutes, then closes with a 408 "QR refs attempts ended"). The disconnect table
 * below must NOT see this: an unscanned QR half-populates the credentials, so a plain reconnect would
 * try to LOG IN with them and draw a terminal 401. Wipe the partial registration and register again
 * from scratch, which puts a fresh QR on screen.
 *
 * ⚠️ EXCEPT a 515 (restartRequired). WhatsApp sends exactly that the instant a scan SUCCEEDS —
 * "pairing configured successfully, expect to restart the connection". At that moment the creds are
 * freshly registered but `registered` may not have flushed to our in-memory view yet, so this branch
 * would otherwise wipe a link that just worked and loop forever on a new QR. A 515 is the pairing
 * completing; hand it to `decideReconnect`, which reconnects immediately and logs in.
 */
export function decideCloseAction(input: CloseInput, random: () => number = Math.random): CloseAction {
  const { statusCode, isRegistered, pairingActive, pairingAttempt } = input;

  if (statusCode !== DisconnectReason.restartRequired && !isRegistered && pairingActive) {
    const nextPairingAttempt = pairingAttempt + 1;
    if (nextPairingAttempt >= MAX_QR_ROUNDS) {
      return {
        kind: 'pairing-give-up',
        message:
          'The QR code expired before it was scanned, several times over. Click "Link WhatsApp" to show a fresh one, and scan it from WhatsApp → Linked Devices right away — each code only lives a couple of minutes.',
      };
    }
    return { kind: 'wipe-and-retry', nextPairingAttempt, delayMs: PAIRING_RETRY_DELAY_MS };
  }

  const decision = decideReconnect(
    { statusCode, attempt: input.attempt, replacedAttempt: input.replacedAttempt },
    random,
  );
  if (decision.kind === 'stop') {
    return {
      kind: 'stop',
      waState: decision.waState,
      wipeCredentials: decision.wipeCredentials,
      message: decision.message,
    };
  }
  return {
    kind: 'reconnect',
    delayMs: decision.delayMs,
    countsAsAttempt: decision.countsAsAttempt,
    bumpReplaced: statusCode === DisconnectReason.connectionReplaced,
  };
}
