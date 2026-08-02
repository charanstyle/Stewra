import { describe, expect, it } from 'vitest';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { MAX_QR_ROUNDS, PAIRING_RETRY_DELAY_MS, decideCloseAction } from '../core/closePolicy.js';
import type { CloseInput } from '../core/closePolicy.js';

/**
 * The close table, pinned the same way reconnect.test.ts pins the disconnect table: pure inputs,
 * real DisconnectReason values, an injected RNG where a branch is jittered.
 */
function input(overrides: Partial<CloseInput>): CloseInput {
  return {
    statusCode: undefined,
    isRegistered: true,
    pairingActive: false,
    pairingAttempt: 0,
    attempt: 0,
    replacedAttempt: 0,
    ...overrides,
  };
}

/** Mid-pairing: an unscanned session — nothing registered, QR still on screen. */
function pairing(overrides: Partial<CloseInput>): CloseInput {
  return input({ isRegistered: false, pairingActive: true, ...overrides });
}

describe('decideCloseAction', () => {
  it('wipes the partial credentials and retries when the QR expires unscanned (rounds 1 and 2)', () => {
    expect(decideCloseAction(pairing({ statusCode: DisconnectReason.timedOut }))).toEqual({
      kind: 'wipe-and-retry',
      nextPairingAttempt: 1,
      delayMs: PAIRING_RETRY_DELAY_MS,
    });
    expect(decideCloseAction(pairing({ statusCode: DisconnectReason.timedOut, pairingAttempt: 1 }))).toEqual({
      kind: 'wipe-and-retry',
      nextPairingAttempt: 2,
      delayMs: PAIRING_RETRY_DELAY_MS,
    });
  });

  it(`gives up with the user's message after ${MAX_QR_ROUNDS} expired QR rounds`, () => {
    const action = decideCloseAction(
      pairing({ statusCode: DisconnectReason.timedOut, pairingAttempt: MAX_QR_ROUNDS - 1 }),
    );
    expect(action.kind).toBe('pairing-give-up');
    if (action.kind === 'pairing-give-up') {
      expect(action.message).toContain('QR code expired');
    }
  });

  it('takes ANY close mid-pairing through the wipe branch — a 428, an unknown code, no code at all', () => {
    for (const statusCode of [DisconnectReason.connectionClosed, 999, undefined]) {
      expect(decideCloseAction(pairing({ statusCode })).kind).toBe('wipe-and-retry');
    }
  });

  it('treats a 515 mid-pairing as the pairing SUCCEEDING: reconnect immediately, never wipe', () => {
    // WhatsApp sends 515 the instant a scan succeeds; wiping here would destroy a link that just worked.
    expect(decideCloseAction(pairing({ statusCode: DisconnectReason.restartRequired }))).toEqual({
      kind: 'reconnect',
      delayMs: 0,
      countsAsAttempt: false,
      bumpReplaced: false,
    });
  });

  it('stops and wipes on loggedOut and badSession once registered — even if pairingActive is stale', () => {
    for (const statusCode of [DisconnectReason.loggedOut, DisconnectReason.badSession]) {
      const action = decideCloseAction(input({ statusCode, pairingActive: true }));
      expect(action).toMatchObject({ kind: 'stop', waState: 'logged_out', wipeCredentials: true });
    }
  });

  it('stops with the banned state, unsoftened, on a forbidden', () => {
    const action = decideCloseAction(input({ statusCode: DisconnectReason.forbidden }));
    expect(action).toMatchObject({ kind: 'stop', waState: 'banned', wipeCredentials: true });
    if (action.kind === 'stop') expect(action.message).toContain('banned');
  });

  it('backs off hard on a session takeover and flags the replaced-counter bump', () => {
    expect(decideCloseAction(input({ statusCode: DisconnectReason.connectionReplaced }))).toEqual({
      kind: 'reconnect',
      delayMs: 5 * 60 * 1000,
      countsAsAttempt: false,
      bumpReplaced: true,
    });
  });

  it('gives up on a persistent takeover without wiping — the session is still the user’s to reclaim', () => {
    const action = decideCloseAction(input({ statusCode: DisconnectReason.connectionReplaced, replacedAttempt: 3 }));
    expect(action).toMatchObject({ kind: 'stop', waState: 'disconnected', wipeCredentials: false });
  });

  it('passes ordinary drops to the jittered backoff table, deterministic under the injected RNG', () => {
    expect(decideCloseAction(input({ statusCode: DisconnectReason.connectionLost, attempt: 2 }), () => 1)).toEqual({
      kind: 'reconnect',
      delayMs: 8_000,
      countsAsAttempt: true,
      bumpReplaced: false,
    });
    expect(decideCloseAction(input({ statusCode: undefined, attempt: 0 }), () => 0.25)).toEqual({
      kind: 'reconnect',
      delayMs: 500,
      countsAsAttempt: true,
      bumpReplaced: false,
    });
  });

  it('parks without wiping after the ordinary-reconnect budget is spent', () => {
    const action = decideCloseAction(input({ statusCode: undefined, attempt: 10 }));
    expect(action).toMatchObject({ kind: 'stop', waState: 'disconnected', wipeCredentials: false });
  });
});
