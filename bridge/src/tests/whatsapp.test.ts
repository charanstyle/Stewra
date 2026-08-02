import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeWaState } from '@stewra/shared-types';
import { WhatsappClient } from '../core/whatsapp.js';
import type { WhatsappEvents, WhatsappMessage } from '../core/whatsapp.js';
import type { SecretStore } from '../core/authState.js';
import { useEncryptedAuthState } from '../core/authState.js';

/**
 * The socket-free surface of the REAL WhatsappClient: everything it promises before/without a live
 * WhatsApp connection, against a real temp session dir. The socket shell itself (`connect()`) hits
 * the real WhatsApp servers by design and is covered by bridge/smoke-selfchat.mts and the eslint
 * ban on `logout` — never by a stand-in here.
 */
const secretStore: SecretStore = {
  encrypt: (plaintext) => Buffer.from(`enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`, 'utf8'),
  decrypt: (ciphertext) => {
    const text = ciphertext.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not ours');
    return Buffer.from(text.slice('enc:'.length), 'base64').toString('utf8');
  },
};

interface Recorded {
  states: Array<[BridgeWaState, string | undefined]>;
  messages: WhatsappMessage[];
  sessionDestroyed: number;
}

function recordingEvents(): { events: WhatsappEvents; seen: Recorded } {
  const seen: Recorded = { states: [], messages: [], sessionDestroyed: 0 };
  return {
    events: {
      onOpen: () => undefined,
      onState: (state, message) => {
        seen.states.push([state, message]);
      },
      onMessage: (message) => {
        seen.messages.push(message);
      },
      onQr: () => undefined,
      onSessionDestroyed: () => {
        seen.sessionDestroyed += 1;
      },
      onChatsMeta: () => undefined,
    },
    seen,
  };
}

describe('WhatsappClient before any socket exists', () => {
  let authDir: string;

  beforeEach(async () => {
    authDir = await mkdtemp(join(tmpdir(), 'stewra-wa-test-'));
  });

  afterEach(async () => {
    await rm(authDir, { recursive: true, force: true });
  });

  const makeClient = (events: WhatsappEvents): WhatsappClient =>
    new WhatsappClient({ authDir, secretStore, appVersion: '1.1.0', events });

  it('reports no identity before a connection', () => {
    const client = makeClient(recordingEvents().events);
    expect(client.ownJid).toBeNull();
    expect(client.ownLid).toBeNull();
  });

  it('stop() before connect never throws, and reports disconnected honestly', () => {
    const { events, seen } = recordingEvents();
    const client = makeClient(events);

    client.stop();

    expect(seen.states).toEqual([['disconnected', undefined]]);
  });

  it('destroySession wipes a real seeded session dir and says so', async () => {
    const { events, seen } = recordingEvents();
    // Seed a REAL session the way production does, so the wipe is observable.
    const auth = await useEncryptedAuthState(authDir, secretStore);
    await auth.saveCreds();
    expect(await readdir(authDir)).toContain('creds.enc');

    await makeClient(events).destroySession();

    await expect(readdir(authDir)).rejects.toThrow();
    expect(seen.sessionDestroyed).toBe(1);
    // stop() ran first: the state was already 'disconnected' by the time the session died.
    expect(seen.states).toEqual([['disconnected', undefined]]);
  });
});
