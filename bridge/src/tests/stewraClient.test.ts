import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import type { Namespace, Socket } from 'socket.io';
import { BRIDGE_CLIENT_EVENTS, BRIDGE_SERVER_EVENTS } from '@stewra/shared-types';
import type { BridgeSendAck, BridgeSendPayload, HostIdentity } from '@stewra/shared-types';
import { StewraClient, claimBridgeToken } from '../core/stewraClient.js';
import type { StewraClientEvents } from '../core/stewraClient.js';

/**
 * A REAL Socket.IO server on loopback — same namespace (`/bridge`), same engine path
 * (`/api/socket.io`), same auth handshake the backend uses — so what's proven here is the actual
 * wire behaviour of the client, not a re-implementation of it. claimBridgeToken is likewise tested
 * against a real local HTTP server. Nothing leaves 127.0.0.1.
 */
const TOKEN = 'device-token-for-tests';

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Recorded {
  connected: number;
  disconnected: number;
  revoked: number;
  sends: BridgeSendPayload[];
}

function recordingEvents(
  onSend?: (payload: BridgeSendPayload) => Promise<BridgeSendAck>,
): { events: StewraClientEvents; seen: Recorded } {
  const seen: Recorded = { connected: 0, disconnected: 0, revoked: 0, sends: [] };
  return {
    events: {
      onConnected: () => {
        seen.connected += 1;
      },
      onDisconnected: () => {
        seen.disconnected += 1;
      },
      onRevoked: () => {
        seen.revoked += 1;
      },
      onSend: async (payload): Promise<BridgeSendAck> => {
        seen.sends.push(payload);
        if (onSend !== undefined) return onSend(payload);
        return { ok: true, providerMessageId: 'WA-1' };
      },
    },
    seen,
  };
}

describe('StewraClient against a real /bridge namespace', () => {
  let http: HttpServer;
  let io: Server;
  let bridgeNs: Namespace;
  let baseUrl: string;
  let client: StewraClient | null = null;
  /** The token each connecting socket presented, in arrival order. */
  let presentedTokens: unknown[];
  let serverSockets: Socket[];

  beforeEach(async () => {
    presentedTokens = [];
    serverSockets = [];
    http = createServer();
    io = new Server(http, { path: '/api/socket.io' });
    bridgeNs = io.of('/bridge');
    bridgeNs.use((socket, next) => {
      presentedTokens.push(socket.handshake.auth['token']);
      if (socket.handshake.auth['token'] !== TOKEN) {
        next(new Error('bad device token'));
        return;
      }
      next();
    });
    bridgeNs.on('connection', (socket) => serverSockets.push(socket));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    client?.disconnect();
    client = null;
    await io.close();
  });

  const makeClient = (events: StewraClientEvents, host: HostIdentity | null = null): StewraClient => {
    client = new StewraClient({ apiBaseUrl: baseUrl, appVersion: '1.1.0' }, host, events);
    return client;
  };

  it('authenticates with the device token and reports the connection', async () => {
    const { events, seen } = recordingEvents();
    makeClient(events).connect(TOKEN);

    await until(() => seen.connected === 1);
    expect(presentedTokens).toEqual([TOKEN]);
  });

  it('never connects with a wrong token — and the app hears nothing but silence, not a phantom session', async () => {
    const { events, seen } = recordingEvents();
    makeClient(events).connect('not-the-token');

    await until(() => presentedTokens.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen.connected).toBe(0);
    expect(serverSockets).toHaveLength(0);
  });

  it('answers bridge:send with the real ack from the app, and refuses a malformed frame without running it', async () => {
    const { events, seen } = recordingEvents();
    makeClient(events).connect(TOKEN);
    await until(() => serverSockets.length === 1);
    const socket = serverSockets[0];
    if (socket === undefined) throw new Error('no server socket');

    const good = await socket
      .timeout(2_000)
      .emitWithAck(BRIDGE_SERVER_EVENTS.SEND, { outboxId: 'o1', jid: 'x@s.whatsapp.net', text: 'hi' });
    expect(good).toEqual({ ok: true, providerMessageId: 'WA-1' });
    expect(seen.sends).toEqual([{ outboxId: 'o1', jid: 'x@s.whatsapp.net', text: 'hi' }]);

    // Malformed: the handler must never see it — a frame that fails the schema is answered, not run.
    const bad = await socket.timeout(2_000).emitWithAck(BRIDGE_SERVER_EVENTS.SEND, { nonsense: true });
    expect(bad).toEqual({ ok: false, error: 'malformed_send' });
    expect(seen.sends).toHaveLength(1);

    // A voice note rides along as base64 OGG/Opus; any other container is refused before the handler.
    const voiced = await socket.timeout(2_000).emitWithAck(BRIDGE_SERVER_EVENTS.SEND, {
      outboxId: 'o2',
      jid: 'x@s.whatsapp.net',
      text: 'spoken',
      audio: { data: 'T2dnUw==', mime: 'audio/ogg', seconds: 2 },
    });
    expect(voiced).toEqual({ ok: true, providerMessageId: 'WA-1' });
    expect(seen.sends[1]).toEqual({
      outboxId: 'o2',
      jid: 'x@s.whatsapp.net',
      text: 'spoken',
      audio: { data: 'T2dnUw==', mime: 'audio/ogg', seconds: 2 },
    });
    const wrongContainer = await socket.timeout(2_000).emitWithAck(BRIDGE_SERVER_EVENTS.SEND, {
      outboxId: 'o3',
      jid: 'x@s.whatsapp.net',
      text: 'spoken',
      audio: { data: 'AAAA', mime: 'audio/wav' },
    });
    expect(wrongContainer).toEqual({ ok: false, error: 'malformed_send' });
    expect(seen.sends).toHaveLength(2);

    // A quoted reply carries the id of the person's message it answers, and nothing else changes.
    const quoted = await socket.timeout(2_000).emitWithAck(BRIDGE_SERVER_EVENTS.SEND, {
      outboxId: 'o4',
      jid: 'x@s.whatsapp.net',
      text: 'in reply',
      replyTo: 'THEIR-MSG-1',
    });
    expect(quoted).toEqual({ ok: true, providerMessageId: 'WA-1' });
    expect(seen.sends[2]).toEqual({ outboxId: 'o4', jid: 'x@s.whatsapp.net', text: 'in reply', replyTo: 'THEIR-MSG-1' });
    // An empty id is not "no quote" — it is a malformed frame, refused before the handler.
    const emptyQuote = await socket.timeout(2_000).emitWithAck(BRIDGE_SERVER_EVENTS.SEND, {
      outboxId: 'o5',
      jid: 'x@s.whatsapp.net',
      text: 'in reply',
      replyTo: '',
    });
    expect(emptyQuote).toEqual({ ok: false, error: 'malformed_send' });
    expect(seen.sends).toHaveLength(3);
  });

  it('turns a send handler crash into an honest error ack instead of a dropped ack', async () => {
    const { events } = recordingEvents(async () => {
      throw new Error('whatsapp exploded');
    });
    makeClient(events).connect(TOKEN);
    await until(() => serverSockets.length === 1);

    const ack = await serverSockets[0]
      ?.timeout(2_000)
      .emitWithAck(BRIDGE_SERVER_EVENTS.SEND, { outboxId: 'o1', jid: 'x@s.whatsapp.net', text: 'hi' });
    expect(ack).toEqual({ ok: false, error: 'whatsapp exploded' });
  });

  it('relays bridge:revoked, and reports a server-side disconnect', async () => {
    const { events, seen } = recordingEvents();
    makeClient(events).connect(TOKEN);
    await until(() => serverSockets.length === 1);

    serverSockets[0]?.emit(BRIDGE_SERVER_EVENTS.REVOKED);
    await until(() => seen.revoked === 1);

    serverSockets[0]?.disconnect(true);
    await until(() => seen.disconnected >= 1);
  });

  it('emits hello / state / inbound / allowed-chats with the shapes the server keys on', async () => {
    const { events } = recordingEvents();
    const stewra = makeClient(events);
    stewra.connect(TOKEN);
    await until(() => serverSockets.length === 1);
    const socket = serverSockets[0];
    if (socket === undefined) throw new Error('no server socket');

    const received: Array<[string, unknown]> = [];
    for (const event of Object.values(BRIDGE_CLIENT_EVENTS)) {
      socket.on(event, (payload: unknown) => received.push([event, payload]));
    }

    stewra.hello('open');
    stewra.state('connecting');
    stewra.inbound({
      providerMessageId: 'WA-9',
      jid: 'me@s.whatsapp.net',
      isSelfChat: true,
      fromMe: true,
      text: 'note to self',
      sentAt: '2026-08-01T00:00:00.000Z',
    });
    stewra.allowedChats([{ jid: 'me@s.whatsapp.net', displayName: 'You', isSelfChat: true }]);
    // An empty allowlist must NOT be sent — the server treats one as a broken bridge, never a wipe.
    stewra.allowedChats([]);

    await until(() => received.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received.map(([event]) => event)).toEqual([
      BRIDGE_CLIENT_EVENTS.HELLO,
      BRIDGE_CLIENT_EVENTS.STATE,
      BRIDGE_CLIENT_EVENTS.INBOUND,
      BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS,
    ]);
    expect(received[0]?.[1]).toEqual({ appVersion: '1.1.0', waState: 'open' });
    expect(received[3]?.[1]).toEqual({
      chats: [{ jid: 'me@s.whatsapp.net', displayName: 'You', isSelfChat: true }],
    });
  });

  it('puts the host identity on the hello, so the server can tell which computer this is', async () => {
    const { events } = recordingEvents();
    const host: HostIdentity = {
      kind: 'darwin-platform-uuid',
      value: '8f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8',
      hostname: 'mac-mini-m2',
    };
    const stewra = makeClient(events, host);
    stewra.connect(TOKEN);
    await until(() => serverSockets.length === 1);
    const socket = serverSockets[0];
    if (socket === undefined) throw new Error('no server socket');

    const received: unknown[] = [];
    socket.on(BRIDGE_CLIENT_EVENTS.HELLO, (payload: unknown) => received.push(payload));
    stewra.hello('open');

    await until(() => received.length === 1);
    // The whole triple, verbatim: the server hashes `kind:value`, so a client that dropped or
    // rewrote either half would place this bridge on a different computer with total confidence.
    expect(received[0]).toEqual({ appVersion: '1.1.0', waState: 'open', host });
  });
});

describe('claimBridgeToken against a real local HTTP server', () => {
  let http: HttpServer;
  let baseUrl: string;
  /** What the next request should be answered with. */
  let respondWith: { status: number; body: string };
  let lastRequest: { url: string | undefined; body: string } | null;

  beforeEach(async () => {
    respondWith = { status: 200, body: '{}' };
    lastRequest = null;
    http = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        lastRequest = { url: request.url, body };
        response.writeHead(respondWith.status, { 'Content-Type': 'application/json' });
        response.end(respondWith.body);
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  const config = (): { apiBaseUrl: string; appVersion: string } => ({ apiBaseUrl: baseUrl, appVersion: '1.1.0' });

  it('posts the code and device identity, and returns the minted token', async () => {
    respondWith = {
      status: 200,
      body: JSON.stringify({ data: { token: 'minted-token', device: { id: 'd1', name: 'Mac' } } }),
    };

    const token = await claimBridgeToken(config(), 'ABCD-1234', 'Mac');

    expect(token).toBe('minted-token');
    expect(lastRequest?.url).toBe('/api/channels/whatsapp-personal/bridge-token');
    expect(JSON.parse(lastRequest?.body ?? '{}')).toEqual({
      code: 'ABCD-1234',
      deviceName: 'Mac',
      appVersion: '1.1.0',
    });
  });

  it('surfaces the server’s own words on a rejection', async () => {
    respondWith = { status: 401, body: JSON.stringify({ message: 'That pairing code is expired' }) };
    await expect(claimBridgeToken(config(), 'OLD-CODE', 'Mac')).rejects.toThrow('That pairing code is expired');
  });

  it('refuses a 200 whose body it does not understand — a token guessed from garbage is worse than none', async () => {
    respondWith = { status: 200, body: JSON.stringify({ data: { nope: true } }) };
    await expect(claimBridgeToken(config(), 'ABCD-1234', 'Mac')).rejects.toThrow(
      'Stewra returned a response this bridge did not understand.',
    );
  });
});
