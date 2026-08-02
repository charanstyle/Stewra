import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import type { Namespace, Socket } from 'socket.io';
import { BRIDGE_CLIENT_EVENTS, BRIDGE_SERVER_EVENTS } from '@stewra/shared-types';
import type { BridgeWaState } from '@stewra/shared-types';
import { Bridge } from '../core/bridge.js';
import type { BridgeEvents } from '../core/bridge.js';
import type { SecretStore } from '../core/authState.js';
import { useEncryptedAuthState } from '../core/authState.js';

/**
 * The REAL Bridge — real AllowlistGate, real ChatDirectory, real StewraClient — against a REAL
 * Socket.IO server on loopback (production namespace, path, and auth) and a REAL temp session dir.
 * The WhatsApp socket is the one absent piece; its event data enters through the Bridge's public
 * WhatsApp-event entry points, which are the exact callbacks the constructor wires. What is proven
 * here is therefore the promise the whole feature stands on: the allowlist gate runs BEFORE the
 * network, on a wire we can watch.
 */
const TOKEN = 'device-token-for-tests';
const SELF_JID = '15550001111@s.whatsapp.net';
const SELF_LID = '111222333@lid';
const FRIEND_JID = '17771112222@s.whatsapp.net';

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Same reversible store as authState.test.ts — a real SecretStore implementation, not encryption. */
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
  qr: string[];
  sessionDestroyed: number;
  revoked: number;
  chatsChanged: number;
  stewraConnection: boolean[];
}

function recordingEvents(): { events: BridgeEvents; seen: Recorded } {
  const seen: Recorded = { states: [], qr: [], sessionDestroyed: 0, revoked: 0, chatsChanged: 0, stewraConnection: [] };
  return {
    events: {
      onState: (state, message) => {
        seen.states.push([state, message]);
      },
      onQr: (qrDataUrl) => {
        seen.qr.push(qrDataUrl);
      },
      onSessionDestroyed: () => {
        seen.sessionDestroyed += 1;
      },
      onRevoked: () => {
        seen.revoked += 1;
      },
      onChatsChanged: () => {
        seen.chatsChanged += 1;
      },
      onStewraConnection: (connected) => {
        seen.stewraConnection.push(connected);
      },
    },
    seen,
  };
}

describe('Bridge against a real /bridge loopback server', () => {
  let http: HttpServer;
  let io: Server;
  let bridgeNs: Namespace;
  let baseUrl: string;
  let authDir: string;
  let bridge: Bridge | null = null;
  let serverSockets: Socket[];
  /** Every frame the server received, in arrival order. */
  let received: Array<[string, unknown]>;

  beforeEach(async () => {
    serverSockets = [];
    received = [];
    authDir = await mkdtemp(join(tmpdir(), 'stewra-bridge-test-'));
    http = createServer();
    io = new Server(http, { path: '/api/socket.io' });
    bridgeNs = io.of('/bridge');
    bridgeNs.use((socket, next) => {
      if (socket.handshake.auth['token'] !== TOKEN) {
        next(new Error('bad device token'));
        return;
      }
      next();
    });
    bridgeNs.on('connection', (socket) => {
      serverSockets.push(socket);
      for (const event of Object.values(BRIDGE_CLIENT_EVENTS)) {
        socket.on(event, (payload: unknown) => received.push([event, payload]));
      }
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    bridge?.stop();
    bridge = null;
    await io.close();
    await rm(authDir, { recursive: true, force: true });
  });

  const connectedBridge = async (events: BridgeEvents): Promise<Bridge> => {
    bridge = new Bridge({
      config: { apiBaseUrl: baseUrl, appVersion: '1.1.0' },
      authDir,
      secretStore,
      events,
      chatsChangedDebounceMs: 30,
    });
    bridge.connectStewra(TOKEN);
    await until(() => serverSockets.length === 1);
    return bridge;
  };

  const framesOf = (event: string): unknown[] =>
    received.filter(([name]) => name === event).map(([, payload]) => payload);

  it('creates a real gate on open and syncs a never-empty allowlist with the self-chat', async () => {
    const b = await connectedBridge(recordingEvents().events);

    b.handleWaOpen({ ownJid: SELF_JID, ownLid: SELF_LID });

    await until(() => framesOf(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS).length === 1);
    expect(framesOf(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS)[0]).toEqual({
      chats: [{ jid: SELF_JID, displayName: 'You', isSelfChat: true }],
    });
  });

  it('forwards NOTHING for a chat the user has not ticked — zero frames, fetch never called', async () => {
    const b = await connectedBridge(recordingEvents().events);
    b.handleWaOpen({ ownJid: SELF_JID, ownLid: SELF_LID });
    await until(() => framesOf(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS).length === 1);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    b.handleWaMessage({
      providerMessageId: 'WA-SECRET',
      remoteJid: FRIEND_JID,
      fromMe: false,
      text: 'this must never leave the machine',
      sentAt: new Date(),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(framesOf(BRIDGE_CLIENT_EVENTS.INBOUND)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('drops a message that arrives before WhatsApp has opened — no gate, no frame', async () => {
    const b = await connectedBridge(recordingEvents().events);

    b.handleWaMessage({
      providerMessageId: 'WA-EARLY',
      remoteJid: FRIEND_JID,
      fromMe: false,
      text: 'too early',
      sentAt: new Date(),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(framesOf(BRIDGE_CLIENT_EVENTS.INBOUND)).toEqual([]);
  });

  it("forwards a ticked chat's message as a real bridge:inbound frame", async () => {
    const b = await connectedBridge(recordingEvents().events);
    b.handleWaOpen({ ownJid: SELF_JID, ownLid: SELF_LID });
    b.setTickedChats([{ jid: FRIEND_JID, displayName: 'Friend', isSelfChat: false }]);
    await until(() => framesOf(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS).length === 2);

    const sentAt = new Date('2026-08-01T12:00:00.000Z');
    b.handleWaMessage({ providerMessageId: 'WA-1', remoteJid: FRIEND_JID, fromMe: false, text: 'hi', sentAt });

    await until(() => framesOf(BRIDGE_CLIENT_EVENTS.INBOUND).length === 1);
    expect(framesOf(BRIDGE_CLIENT_EVENTS.INBOUND)[0]).toEqual({
      providerMessageId: 'WA-1',
      jid: FRIEND_JID,
      isSelfChat: false,
      fromMe: false,
      text: 'hi',
      sentAt: sentAt.toISOString(),
    });
  });

  it('canonicalises a LID-addressed self-chat message to the phone JID on the wire', async () => {
    const b = await connectedBridge(recordingEvents().events);
    b.handleWaOpen({ ownJid: SELF_JID, ownLid: SELF_LID });
    await until(() => framesOf(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS).length === 1);

    b.handleWaMessage({
      providerMessageId: 'WA-SELF',
      remoteJid: SELF_LID,
      fromMe: true,
      text: 'note to self',
      sentAt: new Date(),
    });

    await until(() => framesOf(BRIDGE_CLIENT_EVENTS.INBOUND).length === 1);
    expect(framesOf(BRIDGE_CLIENT_EVENTS.INBOUND)[0]).toMatchObject({
      providerMessageId: 'WA-SELF',
      jid: SELF_JID,
      isSelfChat: true,
    });
  });

  it('refuses a real bridge:send while WhatsApp is not open, and reports state truthfully', async () => {
    const b = await connectedBridge(recordingEvents().events);
    b.handleWaState('connecting');
    await until(() => framesOf(BRIDGE_CLIENT_EVENTS.STATE).length === 1);

    const ack = await serverSockets[0]
      ?.timeout(2_000)
      .emitWithAck(BRIDGE_SERVER_EVENTS.SEND, { outboxId: 'o1', jid: FRIEND_JID, text: 'reply' });
    expect(ack).toEqual({ ok: false, error: 'whatsapp_not_connected' });
    expect(framesOf(BRIDGE_CLIENT_EVENTS.STATE)[0]).toEqual({ waState: 'connecting' });
  });

  it('destroys the real session and disconnects when the server revokes the device', async () => {
    const { events, seen } = recordingEvents();
    const b = await connectedBridge(events);
    // A real seeded session, so the wipe is observable: creds.enc exists before, the dir is gone after.
    const auth = await useEncryptedAuthState(authDir, secretStore);
    await auth.saveCreds();
    expect(await readdir(authDir)).toContain('creds.enc');
    expect(b).not.toBeNull();

    const disconnects: string[] = [];
    serverSockets[0]?.on('disconnect', (reason) => disconnects.push(reason));
    serverSockets[0]?.emit(BRIDGE_SERVER_EVENTS.REVOKED);

    await until(() => seen.revoked === 1);
    // The teardown is fire-and-forget (`void destroySession()`), so the wipe is polled for.
    await until(() => seen.sessionDestroyed === 1);
    await expect(readdir(authDir)).rejects.toThrow();
    await until(() => disconnects.length === 1);
  });

  it('reports the Stewra link coming up, and going down when the server drops it', async () => {
    const { events, seen } = recordingEvents();
    await connectedBridge(events);

    await until(() => seen.stewraConnection.length === 1);
    expect(seen.stewraConnection).toEqual([true]);

    // The server severs the connection — an outage, not a revoke. The UI must learn the link is down,
    // because a message forwarded now is dropped, not queued.
    serverSockets[0]?.disconnect(true);
    await until(() => seen.stewraConnection.length >= 2);
    expect(seen.stewraConnection[1]).toBe(false);
  });

  it('debounces a burst of chat metadata into one repaint, and excludes the self-chat from getChats', async () => {
    const { events, seen } = recordingEvents();
    const b = await connectedBridge(events);
    b.handleWaOpen({ ownJid: SELF_JID, ownLid: SELF_LID });

    b.handleWaChatsMeta({ chats: [{ id: SELF_JID, name: 'Me', timestampSeconds: 200 }] });
    b.handleWaChatsMeta({ chats: [{ id: FRIEND_JID, name: 'Friend', timestampSeconds: 100 }] });
    b.handleWaChatsMeta({ contacts: [{ id: '123-456@g.us', name: 'A Group' }] });

    await until(() => seen.chatsChanged === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen.chatsChanged).toBe(1);

    expect(b.getChats()).toEqual([{ jid: FRIEND_JID, displayName: 'Friend', lastActivity: 100_000 }]);
  });
});
