import type { Mocked } from 'vitest';
import { BRIDGE_CLIENT_EVENTS, BRIDGE_SERVER_EVENTS } from '@stewra/shared-types';
import type { BridgeSendPayload, Message, ProposedEmail } from '@stewra/shared-types';
import type { SocketData } from '../websocket/types.js';

// `vi.hoisted` because Vitest lifts the `vi.mock` factory below above the module body, so a plain `const`
// would still be in its temporal dead zone when the factory runs. Both bindings come back out: the config
// stub needs `whatsappPersonal` (and keeps its identity, so `beforeEach` mutating `.enabled` still reaches
// the service), and the rate-limit test below asserts against `MAX_SENDS_PER_MINUTE` directly.
const { whatsappPersonal, MAX_SENDS_PER_MINUTE } = vi.hoisted(() => {
  const MAX_SENDS_PER_MINUTE = 3;
  return {
    MAX_SENDS_PER_MINUTE,
    whatsappPersonal: {
      enabled: true,
      downloadUrl: 'https://downloads.example.test/stewra-bridge',
      minBridgeVersion: '1.0.0',
      maxSendsPerMinute: MAX_SENDS_PER_MINUTE,
      retentionDays: 30,
      bridgeTokenBytes: 32,
    },
  };
});

vi.mock('../config/unifiedConfig.js', () => ({
  config: {
    get whatsappPersonal() {
      return whatsappPersonal;
    },
    // `whatsappBridgeService` pulls in the real `preferencesService` (for the approve-to-send opt-in),
    // which transitively loads the DB module. That module reads `config.database.url` at import time and
    // constructs a lazy pg `Pool` — no connection is made unless a query runs, and none of these tests
    // exercise the email-draft path, so this stub only has to satisfy the import.
    database: { url: 'postgres://unused-in-this-suite' },
  },
}));

// A stand-in for the real HMAC: this suite is about the dedupe/allowlist LOGIC, not the crypto (which the
// vault's own tests cover). It only has to be deterministic, which is the property the dedupe key needs.
vi.mock('../control-plane/vault/fieldCrypto.js', () => ({
  hmacField: (plaintext: string): string => `hmac(${plaintext})`,
}));

vi.mock('../repositories/whatsappStore.js', () => ({
  whatsappStore: {
    replaceAllowedChats: vi.fn(),
    findChatByJid: vi.fn(),
    findChatById: vi.fn(),
    recordMessage: vi.fn(),
    enqueueSend: vi.fn(),
    pendingSends: vi.fn(),
    markSent: vi.fn(),
    markAttemptFailed: vi.fn(),
    markFailed: vi.fn(),
  },
}));
vi.mock('../repositories/bridgeDeviceRepository.js', () => ({
  bridgeDeviceRepository: {
    markSeen: vi.fn(),
    findByToken: vi.fn(),
    revoke: vi.fn(),
  },
}));
vi.mock('../repositories/channelIdentityRepository.js', () => ({
  channelIdentityRepository: { claimInboundMessage: vi.fn() },
}));
vi.mock('../control-plane/audit/auditWriter.js', () => ({ auditWriter: { write: vi.fn() } }));
vi.mock('../services/stewraTurnService.js', () => ({
  STEWRA_FAILURE_TEXT: 'Stewra could not reply just now. Please try again.',
  stewraTurnService: { handleUserTurn: vi.fn() },
}));
vi.mock('../services/redisClient.js', () => ({
  redis: { incr: vi.fn(), expire: vi.fn() },
}));

import { bridgeDeviceRepository } from '../repositories/bridgeDeviceRepository.js';
import { channelIdentityRepository } from '../repositories/channelIdentityRepository.js';
import { whatsappStore } from '../repositories/whatsappStore.js';
import { redis } from '../services/redisClient.js';
import { stewraTurnService } from '../services/stewraTurnService.js';
import { whatsappPersonalService } from '../services/whatsappPersonalService.js';
import { bridgeAuthMiddleware } from '../websocket/bridgeAuthMiddleware.js';
import { notifyRevoked, setBridgeNamespace } from '../websocket/bridgeEmitter.js';
import { registerBridgeHandler } from '../websocket/bridgeHandler.js';
import { bridgeUserRoom } from '../websocket/bridgeTypes.js';
import type { BridgeRemoteSocketLike } from '../websocket/bridgeTypes.js';

const store = whatsappStore as Mocked<typeof whatsappStore>;
const devices = bridgeDeviceRepository as Mocked<typeof bridgeDeviceRepository>;
const identities = channelIdentityRepository as Mocked<typeof channelIdentityRepository>;
const turns = stewraTurnService as Mocked<typeof stewraTurnService>;
const cache = redis as Mocked<typeof redis>;

const USER = 'user-1';
const DEVICE = 'device-1';
const OTHER_DEVICE = 'device-2';
const SELF_JID = '447700900123@s.whatsapp.net';
const FRIEND_JID = '447700900999@s.whatsapp.net';
const SELF_CHAT = { id: 'chat-self', jid: SELF_JID, isSelfChat: true };
const FRIEND_CHAT = { id: 'chat-friend', jid: FRIEND_JID, isSelfChat: false };

/**
 * A fake Stewra Bridge: the desktop app, minus the desktop, minus Baileys, minus WhatsApp.
 *
 * The whole point of Phase 2 is that every rule protecting a user's WhatsApp account — the allowlist gate,
 * the dedupe, the echo-loop break, the send budget — is enforced on the SERVER and is therefore provable
 * without any of that. This class is what makes the proof possible: it speaks the same events a real bridge
 * speaks, and it lets a test decide what the bridge acks, including lying.
 */
class FakeBridge {
  readonly data: SocketData;
  /** Everything the server told this bridge to send to WhatsApp. */
  readonly sent: BridgeSendPayload[] = [];
  /** Server → bridge events other than sends (i.e. `bridge:revoked`). */
  readonly received: string[] = [];
  disconnected = false;
  /** What this bridge claims happened when it tried to send. Overridable — a bridge can fail, or lie. */
  ack: (payload: BridgeSendPayload) => unknown = (payload) => ({
    ok: true,
    providerMessageId: `wa-${payload.outboxId}`,
  });

  private readonly rooms = new Set<string>();
  private readonly listeners = new Map<string, (payload: unknown) => void>();

  constructor(deviceId: string) {
    this.data = { userId: USER, deviceId };
  }

  readonly id = 'socket-fake';

  // --- the BridgeSocketLike surface: what `registerBridgeHandler` is allowed to do to us ---
  on(event: string, listener: (payload: unknown) => void): unknown {
    this.listeners.set(event, listener);
    return this;
  }
  join(room: string): unknown {
    this.rooms.add(room);
    return undefined;
  }
  disconnect(): unknown {
    this.disconnected = true;
    return undefined;
  }

  // --- the BridgeRemoteSocketLike surface: how the server reaches us ---
  emit(event: string, _payload: unknown): unknown {
    this.received.push(event);
    return true;
  }
  timeout(_ms: number): { emitWithAck(event: string, payload: unknown): Promise<unknown> } {
    return {
      emitWithAck: async (event: string, payload: unknown): Promise<unknown> => {
        expect(event).toBe(BRIDGE_SERVER_EVENTS.SEND);
        const send = payload as BridgeSendPayload;
        this.sent.push(send);
        return this.ack(send);
      },
    };
  }

  inRoom(room: string): boolean {
    return this.rooms.has(room);
  }

  /** Drive the bridge: emit an event at the server exactly as the real app would, and let it settle. */
  async say(event: string, payload: unknown): Promise<void> {
    this.listeners.get(event)?.(payload);
    await settle();
  }
}

/** The handlers are fire-and-forget, so let their promise chains drain before asserting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let bridges: FakeBridge[] = [];

/** Connect a fake bridge: register the handler and put it in the namespace the emitter reaches for. */
function connect(deviceId = DEVICE): FakeBridge {
  const bridge = new FakeBridge(deviceId);
  registerBridgeHandler(bridge);
  bridges.push(bridge);
  return bridge;
}

beforeEach(() => {
  vi.clearAllMocks();
  whatsappPersonal.enabled = true;
  bridges = [];

  setBridgeNamespace({
    in: (room: string) => ({
      fetchSockets: async (): Promise<BridgeRemoteSocketLike[]> =>
        bridges.filter((b) => b.inRoom(room)),
    }),
  });

  // The dedupe claim, as Postgres actually behaves: the first claim on an id wins, every later one loses.
  const claimed = new Set<string>();
  identities.claimInboundMessage.mockImplementation(async (channel: string, id: string) => {
    const key = `${channel}:${id}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  });

  cache.incr.mockResolvedValue(1);
  cache.expire.mockResolvedValue(1);
  store.enqueueSend.mockResolvedValue('outbox-1');
  store.pendingSends.mockResolvedValue([]);
  store.findChatById.mockResolvedValue(SELF_CHAT);
  turns.handleUserTurn.mockResolvedValue(assistantMessage('On it.'));
});

/** What `stewraTurnService` hands back: an ordinary assistant message, on whatever surface asked for it. */
function assistantMessage(content: string, proposedEmail: ProposedEmail | null = null): Message {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    senderId: null,
    senderKind: 'assistant',
    type: 'text',
    content,
    mediaUrl: null,
    mediaType: null,
    mediaDurationSec: null,
    thumbnailUrl: null,
    audioUrl: null,
    transcript: null,
    replyToId: null,
    isEdited: false,
    isDeleted: false,
    deliveredAt: null,
    status: 'sent',
    readReceipts: [],
    createdAt: '2026-07-14T10:00:00.000Z',
    reactions: [],
    proposedEmail,
    proposedRunnerSession: null,
  };
}

const inbound = (jid: string, text: string, providerMessageId: string) => ({
  providerMessageId,
  jid,
  isSelfChat: jid === SELF_JID,
  fromMe: true,
  text,
  sentAt: '2026-07-14T10:00:00.000Z',
});

/**
 * The gate that decides whether a socket may speak for a user at all. A bridge token is a database row, a
 * user's access token is a signed JWT, and the two are resolved by different code — so neither can ever be
 * accepted where the other belongs. These tests pin that.
 */
describe('bridge handshake auth', () => {
  const handshake = (token?: string) => ({
    id: 'socket-1',
    data: {} as SocketData,
    handshake: { auth: token === undefined ? {} : { token }, headers: {} },
  });

  it('admits a bridge holding a valid device token, and pins the device it speaks for', async () => {
    devices.findByToken.mockResolvedValue({ deviceId: DEVICE, userId: USER });
    const socket = handshake('stwbr_good');

    const next = vi.fn();
    bridgeAuthMiddleware(socket, next);
    await settle();

    expect(next).toHaveBeenCalledWith();
    expect(socket.data).toEqual({ userId: USER, deviceId: DEVICE });
  });

  it("REFUSES a user's access token — a JWT is not a bridge token and never resolves to a device", async () => {
    // `findByToken` hashes what it is given and looks for a row. A JWT has no row, so it can never pass.
    devices.findByToken.mockResolvedValue(null);

    const next = vi.fn();
    bridgeAuthMiddleware(handshake('eyJhbGciOiJIUzI1NiJ9.fake.jwt'), next);
    await settle();

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('REFUSES a revoked token instantly — the row is gone, so the next connect dies', async () => {
    devices.findByToken.mockResolvedValue(null);

    const next = vi.fn();
    bridgeAuthMiddleware(handshake('stwbr_revoked'), next);
    await settle();

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('refuses everyone when the experimental channel is switched off for the deploy', async () => {
    whatsappPersonal.enabled = false;

    const next = vi.fn();
    bridgeAuthMiddleware(handshake('stwbr_good'), next);
    await settle();

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(devices.findByToken).not.toHaveBeenCalled();
  });

  it('refuses a socket with no token at all', () => {
    const next = vi.fn();
    bridgeAuthMiddleware(handshake(), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('bridge:hello', () => {
  it('drains the outbox when the bridge has a live WhatsApp socket', async () => {
    store.pendingSends.mockResolvedValue([
      { outboxId: 'outbox-queued', jid: SELF_JID, text: 'sent while your laptop was shut' },
    ]);
    store.findChatByJid.mockResolvedValue(SELF_CHAT);
    const bridge = connect();

    await bridge.say(BRIDGE_CLIENT_EVENTS.HELLO, { appVersion: '1.0.0', waState: 'open' });

    expect(bridge.sent).toEqual([
      expect.objectContaining({ jid: SELF_JID, text: 'sent while your laptop was shut' }),
    ]);
    expect(store.markSent).toHaveBeenCalledWith('outbox-queued', DEVICE, 'wa-outbox-queued');
  });

  it('does NOT drain to a bridge whose WhatsApp socket is not open — it would have nowhere to send', async () => {
    store.pendingSends.mockResolvedValue([
      { outboxId: 'outbox-queued', jid: SELF_JID, text: 'still waiting' },
    ]);
    const bridge = connect();

    await bridge.say(BRIDGE_CLIENT_EVENTS.HELLO, { appVersion: '1.0.0', waState: 'connecting' });

    expect(bridge.sent).toEqual([]);
    expect(store.pendingSends).not.toHaveBeenCalled();
  });

  it('records what the bridge reports, so the web app\'s status dot tells the truth', async () => {
    const bridge = connect();
    await bridge.say(BRIDGE_CLIENT_EVENTS.STATE, { waState: 'banned' });
    expect(devices.markSeen).toHaveBeenCalledWith(DEVICE, 'banned');
  });
});

/**
 * The allowlist. The bridge filters on the user's own machine — that is the privacy story — but the server
 * filters AGAIN, because "the client promised" is not a security control.
 */
describe('bridge:inbound', () => {
  it('DROPS a message from a chat the user never allowed, whatever the bridge claims', async () => {
    store.findChatByJid.mockResolvedValue(null);
    const bridge = connect();

    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(FRIEND_JID, 'hello?', 'wa-1'));

    expect(store.recordMessage).not.toHaveBeenCalled();
    expect(turns.handleUserTurn).not.toHaveBeenCalled();
  });

  it('stores a third-party message but NEVER answers it — Stewra does not speak for the user', async () => {
    store.findChatByJid.mockResolvedValue(FRIEND_CHAT);
    const bridge = connect();

    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(FRIEND_JID, 'are we still on?', 'wa-2'));

    expect(store.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: FRIEND_CHAT.id, direction: 'inbound' }),
    );
    expect(turns.handleUserTurn).not.toHaveBeenCalled();
    expect(bridge.sent).toEqual([]);
  });

  it('answers in the self-chat, and sends the reply back through the bridge', async () => {
    store.findChatByJid.mockResolvedValue(SELF_CHAT);
    const bridge = connect();

    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'what is on today?', 'wa-3'));

    expect(turns.handleUserTurn).toHaveBeenCalledWith(USER, 'what is on today?');
    expect(bridge.sent).toEqual([
      expect.objectContaining({ outboxId: 'outbox-1', jid: SELF_JID, text: 'On it.' }),
    ]);
  });

  // The email-draft copy (opt-in ON vs OFF, and the rule that neither branch claims a send) is a pure
  // function of the reply — `renderWhatsappEmailReply` — and is pinned end-to-end, with no mocks, in
  // whatsappEmailNotice.test.ts. The self-chat wiring that feeds it the opt-in is covered by the live
  // WhatsApp smoke test, so it is deliberately not re-asserted through this fake-bridge harness.

  it('ignores a redelivery of a message it already handled', async () => {
    store.findChatByJid.mockResolvedValue(SELF_CHAT);
    const bridge = connect();

    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'hi', 'wa-4'));
    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'hi', 'wa-4'));

    expect(turns.handleUserTurn).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed payload instead of storing it', async () => {
    const bridge = connect();
    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, { jid: SELF_JID, text: '' });

    expect(store.findChatByJid).not.toHaveBeenCalled();
    expect(store.recordMessage).not.toHaveBeenCalled();
  });
});

/**
 * ⚠️ THE ECHO LOOP — the bug that would have banned real accounts.
 *
 * Stewra's reply is sent FROM the user's own WhatsApp account, into the user's own self-chat. WhatsApp
 * echoes it straight back to the bridge as a new `fromMe` self-chat message. Handled naively, that echo is
 * a new user turn, whose reply is echoed again — an infinite loop, sending message after message from a
 * real account until WhatsApp kills it.
 *
 * The break is that the server claims the id of its OWN outbound message the moment the bridge reports it,
 * so the echo arrives and loses the dedupe race. This test is the reason that code exists; if it ever goes
 * red, do not "fix" the test.
 */
describe('the echo loop', () => {
  it('does not answer its own reply when WhatsApp echoes it back', async () => {
    store.findChatByJid.mockResolvedValue(SELF_CHAT);
    const bridge = connect();

    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'morning', 'wa-user-1'));

    const reply = bridge.sent[0];
    expect(reply).toBeDefined();
    expect(turns.handleUserTurn).toHaveBeenCalledTimes(1);

    // WhatsApp now echoes Stewra's own reply back to the bridge, exactly as it would in real life.
    const echoedId = `wa-${reply?.outboxId ?? ''}`;
    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'On it.', echoedId));

    // Still ONE turn, and still ONE outbound message. The loop never starts.
    expect(turns.handleUserTurn).toHaveBeenCalledTimes(1);
    expect(bridge.sent).toHaveLength(1);
  });
});

/**
 * The send budget is a safety device, not a throughput tunable: outbound volume is what gets a WhatsApp
 * account banned, so if something is generating sends in a loop the right move is to STOP, loudly.
 */
describe('the send budget', () => {
  it('refuses to send once the per-minute budget is spent, and marks the send failed', async () => {
    store.findChatByJid.mockResolvedValue(SELF_CHAT);
    cache.incr.mockResolvedValue(MAX_SENDS_PER_MINUTE + 1);
    const bridge = connect();

    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'hello', 'wa-5'));

    expect(bridge.sent).toEqual([]);
    expect(store.markFailed).toHaveBeenCalledWith('outbox-1', expect.stringContaining('loop'));
  });
});

describe('send failures', () => {
  it('does not mark a send as delivered when the bridge says it failed', async () => {
    store.findChatByJid.mockResolvedValue(SELF_CHAT);
    const bridge = connect();
    bridge.ack = () => ({ ok: false, error: 'wa_disconnected' });

    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'hello', 'wa-6'));

    expect(store.markSent).not.toHaveBeenCalled();
    expect(store.markAttemptFailed).toHaveBeenCalledWith('outbox-1', 'wa_disconnected', 3);
  });

  it('treats a nonsense ack as a failure rather than writing it to the database', async () => {
    store.findChatByJid.mockResolvedValue(SELF_CHAT);
    const bridge = connect();
    bridge.ack = () => ({ ok: 'yes please' });

    await bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'hello', 'wa-7'));

    expect(store.markSent).not.toHaveBeenCalled();
    expect(store.markAttemptFailed).toHaveBeenCalledWith('outbox-1', 'malformed_ack', 3);
  });
});

/** Revocation has to reach the machine that was revoked — and only that machine. */
describe('revocation', () => {
  it('tells the revoked bridge to wipe itself, and hangs up on it', async () => {
    const bridge = connect();
    await bridge.say(BRIDGE_CLIENT_EVENTS.HELLO, { appVersion: '1.0.0', waState: 'open' });

    await notifyRevoked(USER, DEVICE);

    expect(bridge.received).toEqual([BRIDGE_SERVER_EVENTS.REVOKED]);
    expect(bridge.disconnected).toBe(true);
  });

  it("leaves the user's OTHER bridge alone — revoking a laptop must not kill the desktop", async () => {
    const revoked = connect(DEVICE);
    const kept = connect(OTHER_DEVICE);
    await revoked.say(BRIDGE_CLIENT_EVENTS.HELLO, { appVersion: '1.0.0', waState: 'open' });
    await kept.say(BRIDGE_CLIENT_EVENTS.HELLO, { appVersion: '1.0.0', waState: 'open' });

    await notifyRevoked(USER, DEVICE);

    expect(kept.received).toEqual([]);
    expect(kept.disconnected).toBe(false);
  });

  it('joins the user room, so any of their machines can drain a queued send', () => {
    const bridge = connect();
    expect(bridge.inRoom(bridgeUserRoom(USER))).toBe(true);
  });
});

/** The allowlist the device pushes is authoritative — but an EMPTY one is a bug, never an instruction. */
describe('bridge:allowed-chats', () => {
  it('syncs the ticked chats', async () => {
    const bridge = connect();
    await bridge.say(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS, {
      chats: [{ jid: SELF_JID, displayName: 'You', isSelfChat: true }],
    });

    expect(store.replaceAllowedChats).toHaveBeenCalledWith(USER, [
      { jid: SELF_JID, displayName: 'You', isSelfChat: true },
    ]);
  });

  it('REFUSES an empty allowlist rather than deleting everything the user allowed', async () => {
    const bridge = connect();
    await bridge.say(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS, { chats: [] });

    expect(store.replaceAllowedChats).not.toHaveBeenCalled();
  });
});

/** Revoking through the service must reach the socket layer, not just the database. */
describe('whatsappPersonalService.revokeDevice', () => {
  it('is wired to the bridge, so a revoked device stops immediately', async () => {
    devices.revoke.mockResolvedValue(true);
    const bridge = connect();
    await bridge.say(BRIDGE_CLIENT_EVENTS.HELLO, { appVersion: '1.0.0', waState: 'open' });

    await whatsappPersonalService.revokeDevice(USER, DEVICE);

    expect(bridge.disconnected).toBe(true);
  });

  it('leaves a still-connected bridge alone when there was no row to revoke', async () => {
    // A revoke that deleted nothing (wrong id, or someone else's device) must not knock a live bridge off.
    devices.revoke.mockResolvedValue(false);
    const bridge = connect();
    await bridge.say(BRIDGE_CLIENT_EVENTS.HELLO, { appVersion: '1.0.0', waState: 'open' });

    await whatsappPersonalService.revokeDevice(USER, DEVICE);

    expect(bridge.disconnected).toBe(false);
  });
});
