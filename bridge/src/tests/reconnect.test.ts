import { describe, expect, it } from 'vitest';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { decideReconnect } from '../core/reconnect.js';

const decide = (statusCode: number | undefined, attempt = 0, replacedAttempt = 0) =>
  decideReconnect({ statusCode, attempt, replacedAttempt }, () => 1);

/**
 * The disconnect table is the difference between a bridge that survives a flaky wifi and one that
 * reconnects its way into a banned account. Baileys' README suggests `statusCode !== loggedOut` — every
 * test here is a case where that one-liner does the wrong thing.
 */
describe('decideReconnect', () => {
  it('NEVER reconnects after a logout, and wipes the dead session', () => {
    const decision = decide(DisconnectReason.loggedOut);

    expect(decision.kind).toBe('stop');
    if (decision.kind !== 'stop') throw new Error('unreachable');
    expect(decision.waState).toBe('logged_out');
    expect(decision.wipeCredentials).toBe(true);
  });

  it('NEVER reconnects on a bad session — retrying just re-fails forever', () => {
    const decision = decide(DisconnectReason.badSession);

    expect(decision.kind).toBe('stop');
    if (decision.kind !== 'stop') throw new Error('unreachable');
    expect(decision.wipeCredentials).toBe(true);
  });

  it('reports a ban AS a ban, in the user\'s own words, and does not soften it', () => {
    const decision = decide(DisconnectReason.forbidden);

    expect(decision.kind).toBe('stop');
    if (decision.kind !== 'stop') throw new Error('unreachable');
    // This is the outcome they consented to risk. Reporting it as a generic "disconnected" would hide
    // from them the one thing we promised to be honest about.
    expect(decision.waState).toBe('banned');
    expect(decision.message).toContain('banned');
    expect(decision.message).toContain('not reversible');
    expect(decision.wipeCredentials).toBe(true);
  });

  it('restarts immediately when WhatsApp asks, without burning an attempt', () => {
    const decision = decide(DisconnectReason.restartRequired, 3);

    expect(decision).toEqual({ kind: 'reconnect', delayMs: 0, countsAsAttempt: false });
  });

  it('backs off HARD when another client takes the session, instead of fighting it', () => {
    const decision = decide(DisconnectReason.connectionReplaced);

    expect(decision.kind).toBe('reconnect');
    if (decision.kind !== 'reconnect') throw new Error('unreachable');
    // Minutes, not milliseconds. Two clients reconnecting into each other is the storm that gets an
    // account flagged.
    expect(decision.delayMs).toBeGreaterThanOrEqual(60_000);
  });

  it('gives up on a takeover fight rather than keep reconnecting into it', () => {
    const decision = decide(DisconnectReason.connectionReplaced, 0, 3);

    expect(decision.kind).toBe('stop');
    if (decision.kind !== 'stop') throw new Error('unreachable');
    expect(decision.waState).toBe('disconnected');
    // The session is still good — the user just has another WhatsApp Web open. Do not destroy it.
    expect(decision.wipeCredentials).toBe(false);
  });

  it('backs off exponentially on an ordinary drop, and jitters', () => {
    const ceilings = [0, 1, 2, 5].map((attempt) => {
      const decision = decideReconnect({ statusCode: 408, attempt, replacedAttempt: 0 }, () => 1);
      if (decision.kind !== 'reconnect') throw new Error('unreachable');
      return decision.delayMs;
    });

    expect(ceilings).toEqual([2_000, 4_000, 8_000, 64_000]);

    // Full jitter: the delay is a random point BELOW the ceiling, so a WhatsApp outage does not turn
    // every bridge in the world into one synchronised retry stampede.
    const jittered = decideReconnect({ statusCode: 408, attempt: 5, replacedAttempt: 0 }, () => 0.25);
    if (jittered.kind !== 'reconnect') throw new Error('unreachable');
    expect(jittered.delayMs).toBe(16_000);
  });

  it('caps the backoff at five minutes', () => {
    const decision = decideReconnect({ statusCode: 408, attempt: 9, replacedAttempt: 0 }, () => 1);
    if (decision.kind !== 'reconnect') throw new Error('unreachable');
    expect(decision.delayMs).toBe(5 * 60 * 1000);
  });

  it('parks after ten failed attempts instead of retrying forever', () => {
    const decision = decide(408, 10);

    expect(decision.kind).toBe('stop');
    if (decision.kind !== 'stop') throw new Error('unreachable');
    expect(decision.waState).toBe('disconnected');
    expect(decision.wipeCredentials).toBe(false);
  });

  it('treats a socket that just died (no status code) as transient', () => {
    expect(decide(undefined).kind).toBe('reconnect');
  });
});
