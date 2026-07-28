import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { Server as SocketServer } from 'socket.io';
import { io as connectClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { BRIDGE_CLIENT_EVENTS, BRIDGE_SERVER_EVENTS } from '@stewra/shared-types';
import type { BridgeSendPayload } from '@stewra/shared-types';
import type { AppServer } from '../websocket/types.js';
// Type-only, so they are erased and do NOT load these modules here — the graph is still imported
// dynamically below, after this file has set the environment the config reads at module load.
import type { db, closeDb } from '../database/index.js';
import type { bridgeDeviceRepository } from '../repositories/bridgeDeviceRepository.js';
import type { whatsappStore } from '../repositories/whatsappStore.js';
import type { authService } from '../services/authService.js';
import type { redis } from '../services/redisClient.js';
import type { whatsappPersonalService } from '../services/whatsappPersonalService.js';
import type { bridgeUserRoom } from '../websocket/bridgeTypes.js';
import type { initSockets } from '../websocket/index.js';

/**
 * Phase 2 of the experimental companion-device channel, end to end and with nothing stood in for.
 *
 * Every rule here protects a real WhatsApp account from being banned — the allowlist gate, the dedupe,
 * the echo-loop break, the send budget — and each one is a claim about a real system: a row in
 * Postgres, a counter in Redis, a frame on a socket. So all three are real. The suite boots a genuine
 * Socket.IO server through the SAME `initSockets` the app boots, connects genuine `socket.io-client`
 * bridges to the `/bridge` namespace with genuine device tokens, counts sends in the real Redis, and
 * answers turns from a real HTTP model endpoint on localhost. What is absent is only what is genuinely
 * out of reach: WhatsApp itself, and Baileys, which live on the user's own machine by design.
 *
 * The one thing that would make these tests worthless is a stand-in that agrees with them. There is none.
 */

const SELF_JID = '447700900123@s.whatsapp.net';
const FRIEND_JID = '447700900999@s.whatsapp.net';
const MAX_SENDS_PER_MINUTE = 3;
const MODEL_ID = 'stewra-test-model';

/**
 * A per-run prefix for every WhatsApp message id this file invents.
 *
 * `channel_inbound_messages` is a PERMANENT claim table keyed by `hmac(jid):providerMessageId` and
 * scoped to no user — that is the whole point of it, since a redelivery has to lose the race against
 * the original however long ago the original arrived. Nothing clears it between runs, so a hard-coded
 * `'wa-3'` is claimed by the first run and every run after it sees a redelivery instead of a message.
 * Real WhatsApp ids are unique per message; these have to be too. `afterAll` deletes this run's claims.
 */
const RUN_ID = randomUUID().slice(0, 8);
const waId = (suffix: string): string => `wa-${RUN_ID}-${suffix}`;

/** How long a negative assertion waits before concluding nothing is going to happen. */
const QUIET_MS = 1_500;

// ---------------------------------------------------------------------------------------------
// A real model endpoint on localhost, speaking the OpenAI-compatible Chat Completions protocol —
// the same wire `OpenAICompatibleModelClient` speaks to a hosted provider. Pointing MODEL_BASE_URL
// here means the turn really is generated over HTTP by something outside this process; what makes it
// usable in a test is that it is deterministic, not that it is hollow.
// ---------------------------------------------------------------------------------------------

let modelReply = 'On it.';
const modelPrompts: string[] = [];

const modelServer = createServer((req, res) => {
  if (req.method !== 'POST' || req.url === undefined || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    modelPrompts.push(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [
          { index: 0, message: { role: 'assistant', content: modelReply }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  });
});
await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
const modelPort = (modelServer.address() as AddressInfo).port;

// ---------------------------------------------------------------------------------------------
// Config, from the environment, exactly as a deploy does it — pinned before the graph is imported.
// ---------------------------------------------------------------------------------------------

process.env['WHATSAPP_PERSONAL_DOWNLOAD_URL'] = 'https://downloads.example.test/stewra-bridge';
process.env['WHATSAPP_PERSONAL_MIN_BRIDGE_VERSION'] = '1.0.0';
process.env['WHATSAPP_PERSONAL_MAX_SENDS_PER_MINUTE'] = String(MAX_SENDS_PER_MINUTE);
// The Claude CLI is the default provider and would talk to a real subscription; name the
// OpenAI-compatible adapter explicitly and point it at the endpoint above.
process.env['MODEL_PREFER_CLAUDE_CLI'] = 'false';
process.env['MODEL_PROVIDER'] = 'openai';
process.env['MODEL_ID'] = MODEL_ID;
process.env['OPENAI_API_KEY'] = `test-${randomUUID()}`;
process.env['MODEL_BASE_URL'] = `http://127.0.0.1:${modelPort}/v1`;
// VOICE_ENABLED stays off (its default), so a turn produces text and no clip — a WhatsApp reply is
// text anyway. UPLOADS_DIR is still required by the media service that any attachment path touches.
process.env['UPLOADS_DIR'] = mkdtempSync(join(tmpdir(), 'stewra-bridge-test-'));

interface Graph {
  readonly initSockets: typeof initSockets;
  readonly whatsappPersonalService: typeof whatsappPersonalService;
  readonly bridgeDeviceRepository: typeof bridgeDeviceRepository;
  readonly whatsappStore: typeof whatsappStore;
  readonly authService: typeof authService;
  readonly bridgeUserRoom: typeof bridgeUserRoom;
  readonly db: typeof db;
  readonly closeDb: typeof closeDb;
  readonly redis: typeof redis;
}

async function loadGraph(enabled: boolean): Promise<Graph> {
  process.env['WHATSAPP_PERSONAL_ENABLED'] = enabled ? 'true' : 'false';
  vi.resetModules();
  const { initSockets } = await import('../websocket/index.js');
  const { whatsappPersonalService } = await import('../services/whatsappPersonalService.js');
  const { bridgeDeviceRepository } = await import('../repositories/bridgeDeviceRepository.js');
  const { whatsappStore } = await import('../repositories/whatsappStore.js');
  const { authService } = await import('../services/authService.js');
  const { bridgeUserRoom } = await import('../websocket/bridgeTypes.js');
  const { redis } = await import('../services/redisClient.js');
  const database = await import('../database/index.js');
  return {
    initSockets,
    whatsappPersonalService,
    bridgeDeviceRepository,
    whatsappStore,
    authService,
    bridgeUserRoom,
    redis,
    db: database.db,
    closeDb: database.closeDb,
  };
}

const on = await loadGraph(true);
// A second, independently-configured copy of the application with the experimental channel switched
// off — a flag is a property of a process, so "off" is a different process, not a mutated field.
const off = await loadGraph(false);

/** Boot a real Socket.IO server through the app's own `initSockets`, and return where to reach it. */
async function bootServer(graph: Graph): Promise<{ http: HttpServer; io: AppServer; url: string }> {
  const http = createServer();
  const io: AppServer = new SocketServer(http, { transports: ['websocket'] });
  graph.initSockets(io);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return { http, io, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
}

const live = await bootServer(on);
const dark = await bootServer(off);

// ---------------------------------------------------------------------------------------------
// A real bridge client. It is the Stewra Bridge desktop app minus Electron, Baileys, and WhatsApp —
// all of which live on the user's machine and none of which the server can see. What it speaks is the
// real protocol over a real socket, and a test can decide what it acks, including lying.
// ---------------------------------------------------------------------------------------------

class BridgeClient {
  /** Everything the server told this bridge to put on WhatsApp. */
  readonly sent: BridgeSendPayload[] = [];
  /** Server → bridge events other than sends (i.e. `bridge:revoked`). */
  readonly received: string[] = [];
  /** What this bridge claims happened when it tried to send. Overridable — a bridge can fail, or lie. */
  ack: (payload: BridgeSendPayload) => unknown = (payload) => ({
    ok: true,
    providerMessageId: `wa-${payload.outboxId}`,
  });

  constructor(readonly socket: ClientSocket) {
    socket.on(BRIDGE_SERVER_EVENTS.SEND, (payload: BridgeSendPayload, respond: (v: unknown) => void) => {
      this.sent.push(payload);
      respond(this.ack(payload));
    });
    socket.on(BRIDGE_SERVER_EVENTS.REVOKED, () => {
      this.received.push(BRIDGE_SERVER_EVENTS.REVOKED);
    });
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  say(event: string, payload: unknown): void {
    this.socket.emit(event, payload);
  }
}

const clients: ClientSocket[] = [];

/** Connect to `/bridge` and resolve once the handshake succeeds, or reject with the server's reason. */
async function connectBridge(token: string, url = live.url): Promise<BridgeClient> {
  const socket = connectClient(`${url}/bridge`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err: Error) => reject(err));
  });
  return new BridgeClient(socket);
}

/** The same handshake, but for the cases where being REFUSED is the expected outcome. */
async function refusedBridge(auth: Record<string, unknown>, url = live.url): Promise<Error> {
  const socket = connectClient(`${url}/bridge`, {
    auth,
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(socket);
  return new Promise<Error>((resolve, reject) => {
    socket.once('connect', () => reject(new Error('the handshake was accepted, and should not have been')));
    socket.once('connect_error', (err: Error) => resolve(err));
  });
}

// ---------------------------------------------------------------------------------------------
// Waiting. Nothing here is synchronous any more — a frame crosses a socket, a row lands in Postgres —
// so assertions poll for the state they need instead of assuming a turn of the event loop was enough.
// ---------------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

// A real password, really hashed, shared by every throwaway user — so the JWT test below can obtain
// its token from the real `authService.login`, rather than asserting against one this file minted.
const PASSWORD = randomUUID();
const PASSWORD_HASH = await bcrypt.hash(PASSWORD, 10);
const createdUsers: string[] = [];

async function createUser(): Promise<string> {
  const row = await on.db
    .insertInto('users')
    .values({
      email: `bridge-${randomUUID()}@stewra.invalid`,
      display_name: 'Bridge Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

/** A real, signed access token for a user — obtained the way a user obtains one, by signing in. */
async function accessTokenFor(userId: string): Promise<string> {
  const row = await on.db
    .selectFrom('users')
    .select('email')
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  const { tokens } = await on.authService.login({ email: row.email, password: PASSWORD });
  return tokens.accessToken;
}

/** A registered bridge device, through the real repository — token included, exactly once. */
async function registerDevice(userId: string, name = "Robin's MacBook"): Promise<{ token: string; deviceId: string }> {
  const { device, token } = await on.bridgeDeviceRepository.registerDevice({
    userId,
    name,
    appVersion: '1.0.0',
    consentVersion: 1,
    consentedAt: new Date(),
  });
  return { token, deviceId: device.id };
}

interface Fixture {
  readonly userId: string;
  readonly token: string;
  readonly deviceId: string;
  readonly selfChatId: string;
  readonly friendChatId: string;
}

/** A user with a bridge and the usual two allowed chats: their own, and one friend's. */
async function newUserWithBridge(): Promise<Fixture> {
  const userId = await createUser();
  const { token, deviceId } = await registerDevice(userId);
  await on.whatsappStore.replaceAllowedChats(userId, [
    { jid: SELF_JID, displayName: 'You', isSelfChat: true },
    { jid: FRIEND_JID, displayName: 'Sarah', isSelfChat: false },
  ]);
  const selfChat = await on.whatsappStore.findChatByJid(userId, SELF_JID);
  const friendChat = await on.whatsappStore.findChatByJid(userId, FRIEND_JID);
  if (selfChat === null || friendChat === null) throw new Error('allowlist did not persist');
  return { userId, token, deviceId, selfChatId: selfChat.id, friendChatId: friendChat.id };
}

const inbound = (jid: string, text: string, providerMessageId: string): Record<string, unknown> => ({
  providerMessageId,
  jid,
  isSelfChat: jid === SELF_JID,
  fromMe: true,
  text,
  sentAt: new Date().toISOString(),
});

async function storedMessages(userId: string): Promise<Array<{ direction: string; provider_message_id: string }>> {
  return on.db
    .selectFrom('whatsapp_messages')
    .select(['direction', 'provider_message_id'])
    .where('user_id', '=', userId)
    .execute();
}

async function outbox(
  userId: string,
): Promise<Array<{ id: string; status: string; attempts: number; last_error: string | null; provider_message_id: string | null }>> {
  return on.db
    .selectFrom('whatsapp_outbound')
    .select(['id', 'status', 'attempts', 'last_error', 'provider_message_id'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'asc')
    .execute();
}

beforeEach(() => {
  modelReply = 'On it.';
  modelPrompts.length = 0;
});

afterEach(() => {
  for (const socket of clients.splice(0)) socket.disconnect();
});

afterAll(async () => {
  for (const socket of clients.splice(0)) socket.disconnect();
  await Promise.all(
    [live, dark].map(
      ({ io, http }) =>
        new Promise<void>((resolve) => {
          io.close(() => http.close(() => resolve()));
        }),
    ),
  );

  // `initSockets` builds the Socket.IO Redis adapter's own pub/sub pair and hands it to the adapter,
  // which owns it for the process lifetime. A test process does have to end, so they are closed here
  // through the adapter that holds them.
  for (const graph of [on, off]) {
    const adapter = graph.redis;
    await adapter.quit().catch(() => undefined);
  }
  for (const { io } of [live, dark]) {
    const adapter = io.of('/').adapter as unknown as {
      pubClient?: { quit: () => Promise<unknown> };
      subClient?: { quit: () => Promise<unknown> };
    };
    await adapter.pubClient?.quit().catch(() => undefined);
    await adapter.subClient?.quit().catch(() => undefined);
  }

  // The dedupe claims this run staked — both the ids this file invented and the ones the server minted
  // for its own sends (that claim is what breaks the echo loop). They are keyed by message id, not by
  // user, so deleting the users below does not reach them; left alone they pile up forever.
  const sentIds =
    createdUsers.length > 0
      ? await on.db
          .selectFrom('whatsapp_outbound')
          .select('id')
          .where('user_id', 'in', createdUsers)
          .execute()
      : [];
  await on.db
    .deleteFrom('channel_inbound_messages')
    .where((eb) =>
      eb.or([
        eb('provider_message_id', 'like', `%wa-${RUN_ID}-%`),
        ...sentIds.map((row) => eb('provider_message_id', 'like', `%wa-${row.id}`)),
      ]),
    )
    .execute();

  // Users without an audit row go; those with one stay, because `audit_log.user_id` is ON DELETE SET
  // NULL and the table's append-only trigger rejects that UPDATE. The audit log working as designed.
  if (createdUsers.length > 0) {
    await on.db
      .deleteFrom('users')
      .where('id', 'in', createdUsers)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id'))),
      )
      .execute();
  }
  await Promise.all([on.closeDb(), off.closeDb()]);
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
});

/**
 * The gate that decides whether a socket may speak for a user at all. A bridge token is a database row,
 * a user's access token is a signed JWT, and the two are resolved by different code — so neither can
 * ever be accepted where the other belongs. These tests pin that.
 */
describe('bridge handshake auth', () => {
  it('admits a bridge holding a valid device token, and pins the device it speaks for', async () => {
    const { userId, token, deviceId } = await newUserWithBridge();

    const bridge = await connectBridge(token);

    expect(bridge.connected).toBe(true);
    // What the server believes about this socket, read off the server's own socket.
    const sockets = await live.io.of('/bridge').fetchSockets();
    const mine = sockets.filter((s) => s.data.deviceId === deviceId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data.userId).toBe(userId);
  });

  it("REFUSES a user's access token — a JWT is not a bridge token and never resolves to a device", async () => {
    // A genuinely valid, correctly signed access token for a real user. It must still be worthless
    // here: `findByToken` hashes what it is given and looks for a row, and a JWT has no row.
    const { userId } = await newUserWithBridge();
    const jwt = await accessTokenFor(userId);

    const err = await refusedBridge({ token: jwt });

    expect(err.message).toContain('Invalid or revoked bridge token');
  });

  it('REFUSES a revoked token instantly — the row is gone, so the next connect dies', async () => {
    const { userId, token, deviceId } = await newUserWithBridge();
    const before = await connectBridge(token);
    expect(before.connected).toBe(true);

    await on.whatsappPersonalService.revokeDevice(userId, deviceId);

    const err = await refusedBridge({ token });
    expect(err.message).toContain('Invalid or revoked bridge token');
  });

  it('refuses everyone when the experimental channel is switched off for the deploy', async () => {
    // Not "checks a flag and rejects" — with the channel off there is no `/bridge` namespace mounted at
    // all, so a bridge holding a perfectly valid token has nothing to connect to.
    const { token } = await newUserWithBridge();

    const err = await refusedBridge({ token }, dark.url);

    expect(err.message).toContain('Invalid namespace');
  });

  it('refuses a socket with no token at all', async () => {
    const err = await refusedBridge({});
    expect(err.message).toContain('Missing bridge token');
  });
});

describe('bridge:hello', () => {
  it('drains the outbox when the bridge has a live WhatsApp socket', async () => {
    const { userId, token, selfChatId } = await newUserWithBridge();
    const outboxId = await on.whatsappStore.enqueueSend(
      userId,
      selfChatId,
      'sent while your laptop was shut',
    );
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.HELLO, { appVersion: '1.0.0', waState: 'open' });

    await waitFor('the queued send to reach the bridge', () => bridge.sent.length > 0 || undefined);
    expect(bridge.sent[0]).toMatchObject({
      outboxId,
      jid: SELF_JID,
      text: 'sent while your laptop was shut',
    });
    const row = await waitFor('the outbox row to be marked sent', async () =>
      (await outbox(userId)).find((r) => r.status === 'sent'),
    );
    expect(row.provider_message_id).toBe(`wa-${outboxId}`);
  });

  it('does NOT drain to a bridge whose WhatsApp socket is not open — it would have nowhere to send', async () => {
    const { userId, token, selfChatId } = await newUserWithBridge();
    await on.whatsappStore.enqueueSend(userId, selfChatId, 'still waiting');
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.HELLO, { appVersion: '1.0.0', waState: 'connecting' });

    // The state write is the proof the frame was received and handled at all.
    await waitFor('the reported state to be recorded', async () =>
      (await deviceState(token)) === 'connecting' || undefined,
    );
    await sleep(QUIET_MS);
    expect(bridge.sent).toEqual([]);
    expect((await outbox(userId))[0]?.status).toBe('pending');
  });

  it("records what the bridge reports, so the web app's status dot tells the truth", async () => {
    const { token } = await newUserWithBridge();
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.STATE, { waState: 'banned' });

    await waitFor('wa_state to become banned', async () => (await deviceState(token)) === 'banned' || undefined);
  });
});

async function deviceState(token: string): Promise<string | null> {
  const identity = await on.whatsappPersonalService.authenticateBridge(token);
  if (identity === null) return null;
  const row = await on.db
    .selectFrom('bridge_devices')
    .select('wa_state')
    .where('id', '=', identity.deviceId)
    .executeTakeFirst();
  return row?.wa_state ?? null;
}

/**
 * The allowlist. The bridge filters on the user's own machine — that is the privacy story — but the
 * server filters AGAIN, because "the client promised" is not a security control.
 */
describe('bridge:inbound', () => {
  it('DROPS a message from a chat the user never allowed, whatever the bridge claims', async () => {
    const userId = await createUser();
    const { token } = await registerDevice(userId);
    // Only the self-chat is allowed. The bridge below claims a stranger's chat anyway.
    await on.whatsappStore.replaceAllowedChats(userId, [
      { jid: SELF_JID, displayName: 'You', isSelfChat: true },
    ]);
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(FRIEND_JID, 'hello?', waId('1')));
    await sleep(QUIET_MS);

    expect(await storedMessages(userId)).toEqual([]);
    expect(await outbox(userId)).toEqual([]);
  });

  it('stores a third-party message but NEVER answers it — Stewra does not speak for the user', async () => {
    const { userId, token } = await newUserWithBridge();
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(FRIEND_JID, 'are we still on?', waId('2')));

    await waitFor('the message to be stored', async () =>
      (await storedMessages(userId)).length > 0 || undefined,
    );
    await sleep(QUIET_MS);
    expect(await storedMessages(userId)).toEqual([
      { direction: 'inbound', provider_message_id: waId('2') },
    ]);
    expect(bridge.sent).toEqual([]);
    expect(modelPrompts).toEqual([]);
  });

  it('answers in the self-chat, and sends the reply back through the bridge', async () => {
    modelReply = 'Two meetings and a dentist appointment.';
    const { userId, token } = await newUserWithBridge();
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'what is on today?', waId('3')));

    await waitFor('the reply to reach the bridge', () => bridge.sent.length > 0 || undefined);
    expect(bridge.sent[0]).toMatchObject({ jid: SELF_JID, text: modelReply });
    // The turn really went through the model: the user's words are in the prompt it received.
    expect(modelPrompts.join('\n')).toContain('what is on today?');
    // And the reply was queued before it was delivered, then marked sent once the bridge confirmed.
    const row = await waitFor('the outbox row to settle', async () =>
      (await outbox(userId)).find((r) => r.status === 'sent'),
    );
    expect(row.provider_message_id).toBe(`wa-${row.id}`);
  });

  it('ignores a redelivery of a message it already handled', async () => {
    const { userId, token } = await newUserWithBridge();
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'hi', waId('4')));
    await waitFor('the first turn to answer', () => bridge.sent.length > 0 || undefined);

    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'hi', waId('4')));
    await sleep(QUIET_MS);

    // One turn, one reply — the second delivery claimed nothing, so it went no further.
    expect(bridge.sent).toHaveLength(1);
    expect((await storedMessages(userId)).filter((m) => m.provider_message_id === waId('4'))).toHaveLength(1);
  });

  it('rejects a malformed payload instead of storing it', async () => {
    const { userId, token } = await newUserWithBridge();
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, { jid: SELF_JID, text: '' });
    await sleep(QUIET_MS);

    expect(await storedMessages(userId)).toEqual([]);
    expect(await outbox(userId)).toEqual([]);
  });
});

/**
 * ⚠️ THE ECHO LOOP — the bug that would have banned real accounts.
 *
 * Stewra's reply is sent FROM the user's own WhatsApp account, into the user's own self-chat. WhatsApp
 * echoes it straight back to the bridge as a new `fromMe` self-chat message. Handled naively, that echo
 * is a new user turn, whose reply is echoed again — an infinite loop, sending message after message
 * from a real account until WhatsApp kills it.
 *
 * The break is that the server claims the id of its OWN outbound message the moment the bridge reports
 * it, so the echo arrives and loses the dedupe race. This test is the reason that code exists; if it
 * ever goes red, do not "fix" the test.
 */
describe('the echo loop', () => {
  it('does not answer its own reply when WhatsApp echoes it back', async () => {
    const { token } = await newUserWithBridge();
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'morning', waId('user-1')));
    await waitFor('the reply to reach the bridge', () => bridge.sent.length > 0 || undefined);
    const reply = bridge.sent[0];
    expect(reply).toBeDefined();
    expect(modelPrompts).toHaveLength(1);

    // WhatsApp now echoes Stewra's own reply back to the bridge, exactly as it would in real life —
    // same id the bridge just acked with, same `fromMe: true`, same self-chat.
    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, modelReply, `wa-${reply?.outboxId ?? ''}`));
    await sleep(QUIET_MS);

    // Still ONE turn, and still ONE outbound message. The loop never starts.
    expect(modelPrompts).toHaveLength(1);
    expect(bridge.sent).toHaveLength(1);
  });
});

/**
 * The send budget is a safety device, not a throughput tunable: outbound volume is what gets a WhatsApp
 * account banned, so if something is generating sends in a loop the right move is to STOP, loudly.
 */
describe('the send budget', () => {
  it('refuses to send once the per-minute budget is spent, and marks the send failed', async () => {
    const { userId, token } = await newUserWithBridge();
    const bridge = await connectBridge(token);

    // Spend the budget for real, one genuine turn at a time — the counter lives in Redis, not here.
    for (let i = 0; i < MAX_SENDS_PER_MINUTE; i += 1) {
      bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, `hello ${i}`, waId(`budget-${i}`)));
      await waitFor(`send ${i + 1} to go out`, () => bridge.sent.length > i || undefined);
    }

    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'one too many', waId('budget-last')));

    const failed = await waitFor('the over-budget send to be failed', async () =>
      (await outbox(userId)).find((r) => r.status === 'failed'),
    );
    expect(failed.last_error).toContain('loop');
    // The circuit breaker STOPPED the send rather than delivering it late.
    expect(bridge.sent).toHaveLength(MAX_SENDS_PER_MINUTE);
  });
});

describe('send failures', () => {
  it('does not mark a send as delivered when the bridge says it failed', async () => {
    const { userId, token } = await newUserWithBridge();
    const bridge = await connectBridge(token);
    bridge.ack = () => ({ ok: false, error: 'wa_disconnected' });

    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'hello', waId('6')));

    const row = await waitFor('the failed attempt to be recorded', async () =>
      (await outbox(userId)).find((r) => r.attempts > 0),
    );
    expect(row.last_error).toBe('wa_disconnected');
    // Still pending: one failure is retryable, and the next bridge to arrive will try again.
    expect(row.status).toBe('pending');
    expect(row.provider_message_id).toBeNull();
  });

  it('treats a nonsense ack as a failure rather than writing it to the database', async () => {
    const { userId, token } = await newUserWithBridge();
    const bridge = await connectBridge(token);
    bridge.ack = () => ({ ok: 'yes please' });

    bridge.say(BRIDGE_CLIENT_EVENTS.INBOUND, inbound(SELF_JID, 'hello', waId('7')));

    const row = await waitFor('the malformed ack to be recorded as a failure', async () =>
      (await outbox(userId)).find((r) => r.attempts > 0),
    );
    expect(row.last_error).toBe('malformed_ack');
    expect(row.provider_message_id).toBeNull();
  });
});

/** Revocation has to reach the machine that was revoked — and only that machine. */
describe('revocation', () => {
  it('tells the revoked bridge to wipe itself, and hangs up on it', async () => {
    const { userId, token, deviceId } = await newUserWithBridge();
    const bridge = await connectBridge(token);

    await on.whatsappPersonalService.revokeDevice(userId, deviceId);

    await waitFor('the bridge to be told it was revoked', () => bridge.received.length > 0 || undefined);
    expect(bridge.received).toEqual([BRIDGE_SERVER_EVENTS.REVOKED]);
    await waitFor('the socket to be hung up on', () => !bridge.connected || undefined);
  });

  it("leaves the user's OTHER bridge alone — revoking a laptop must not kill the desktop", async () => {
    const { userId, token, deviceId } = await newUserWithBridge();
    const second = await registerDevice(userId, 'Desktop');
    const revoked = await connectBridge(token);
    const kept = await connectBridge(second.token);

    await on.whatsappPersonalService.revokeDevice(userId, deviceId);

    await waitFor('the revoked bridge to be hung up on', () => !revoked.connected || undefined);
    await sleep(QUIET_MS);
    expect(kept.received).toEqual([]);
    expect(kept.connected).toBe(true);
  });

  it('joins the user room, so any of their machines can drain a queued send', async () => {
    const { userId, token, deviceId } = await newUserWithBridge();
    await connectBridge(token);

    const inRoom = await live.io.of('/bridge').in(on.bridgeUserRoom(userId)).fetchSockets();
    expect(inRoom.map((s) => s.data.deviceId)).toEqual([deviceId]);
  });
});

/** The allowlist the device pushes is authoritative — but an EMPTY one is a bug, never an instruction. */
describe('bridge:allowed-chats', () => {
  it('syncs the ticked chats', async () => {
    const userId = await createUser();
    const { token } = await registerDevice(userId);
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS, {
      chats: [{ jid: SELF_JID, displayName: 'You', isSelfChat: true }],
    });

    const chat = await waitFor('the allowlist to be stored', () =>
      on.whatsappStore.findChatByJid(userId, SELF_JID),
    );
    expect(chat).toMatchObject({ jid: SELF_JID, isSelfChat: true });
  });

  it('REFUSES an empty allowlist rather than deleting everything the user allowed', async () => {
    const { userId, token } = await newUserWithBridge();
    const bridge = await connectBridge(token);

    bridge.say(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS, { chats: [] });
    await sleep(QUIET_MS);

    // Both chats the user really ticked are still there.
    expect(await on.whatsappStore.findChatByJid(userId, SELF_JID)).not.toBeNull();
    expect(await on.whatsappStore.findChatByJid(userId, FRIEND_JID)).not.toBeNull();
  });
});

/** Revoking through the service must reach the socket layer, not just the database. */
describe('whatsappPersonalService.revokeDevice', () => {
  it('is wired to the bridge, so a revoked device stops immediately', async () => {
    const { userId, token, deviceId } = await newUserWithBridge();
    const bridge = await connectBridge(token);

    await expect(on.whatsappPersonalService.revokeDevice(userId, deviceId)).resolves.toBe(true);

    await waitFor('the bridge to be disconnected', () => !bridge.connected || undefined);
  });

  it('leaves a still-connected bridge alone when there was no row to revoke', async () => {
    // A revoke that deleted nothing (wrong id, or someone else's device) must not knock a live bridge off.
    const { token } = await newUserWithBridge();
    const stranger = await createUser();
    const bridge = await connectBridge(token);

    await expect(on.whatsappPersonalService.revokeDevice(stranger, randomUUID())).resolves.toBe(false);

    await sleep(QUIET_MS);
    expect(bridge.connected).toBe(true);
  });
});
