// Live WhatsApp smoke driver for the socket shell that no offline test can honestly cover: the real
// `makeWASocket` wiring, a real `sendText`, and the live pairing flow (including WhatsApp's 515
// restart-after-scan). Drives the REAL WhatsappClient against WhatsApp's REAL servers with a QA
// account (see the repo's .env.e2e note) — everything else in bridge/src/core is covered offline.
//
// What the round trip can honestly assert from ONE device: WhatsApp echoes a device's OWN sends back
// as an `append` upsert, and waMapping deliberately never turns `append` into a live message (that
// rule is what stops Stewra answering history). So the send is verified through the two paths the
// echo IS allowed to take — chat activity via onChatsMeta, and the live-message path staying silent.
// The full live path (another device's send arriving as `notify`) is production's job, not this
// driver's; it needs a second device to send, which a single-session script does not have.
//
// Run it by hand — NEVER in CI (it talks to WhatsApp's production servers with a real account):
//   cd bridge && npx tsx smoke-selfchat.mts
//
// First run: a QR PNG is written to bridge/.smoke-session/qr.png — open it and scan from the QA
// phone (WhatsApp → Linked Devices → Link a device). The session persists in bridge/.smoke-session/
// (gitignored — it holds REAL linked-device credentials), so later runs are hands-off. It pairs as
// "Stewra Bridge (smoke)" so it is tellable from the real Bridge in the phone's Linked Devices list.
//
// When done testing, unlink it from HERE, not from the phone:
//   npx tsx smoke-selfchat.mts --logout
// This logs out the one device whose credentials live in .smoke-session (no hunting through the
// phone's device list) and then deletes the session directory. `logout()` is banned in bridge core
// by eslint.config.mjs because there it would destroy the USER's session; unlinking this driver's
// own throwaway pairing is the one legitimate call.
import makeWASocket, { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { WhatsappClient } from './src/core/whatsapp.js';
import { useEncryptedAuthState } from './src/core/authState.js';
import type { WhatsappMessage } from './src/core/whatsapp.js';
import type { SecretStore } from './src/core/authState.js';
import type { ChatMeta } from './src/core/chatDirectory.js';

const SESSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '.smoke-session');
const QR_PATH = join(SESSION_DIR, 'qr.png');

// Smoke-only stand-in for the Electron safeStorage-backed store — reversible base64, NOT encryption.
// Production never uses this (main.ts wires safeStorage); here it just satisfies the SecretStore
// contract so the session survives between runs of this driver.
const secretStore: SecretStore = {
  encrypt: (plaintext) => Buffer.from(`smoke:${Buffer.from(plaintext, 'utf8').toString('base64')}`, 'utf8'),
  decrypt: (ciphertext) => {
    const text = ciphertext.toString('utf8');
    if (!text.startsWith('smoke:')) throw new Error('not a smoke-session credential file');
    return Buffer.from(text.slice('smoke:'.length), 'base64').toString('utf8');
  },
};

let failures = 0;
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

async function until(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main(): Promise<void> {
  console.log('\n== Bridge live self-chat smoke (real WhatsApp servers) ==\n');
  await mkdir(SESSION_DIR, { recursive: true });

  // A holder, not a `let`: TypeScript does not track assignments made inside a callback, so a plain
  // `let opened = null` stays narrowed to `null` at every read below (the runner smoke driver hit the
  // same wall — see runner/smoke-session.mts).
  const opened: { identity?: { readonly ownJid: string; readonly ownLid: string | null } } = {};
  let open = false;
  let lastState = '';
  const received: WhatsappMessage[] = [];
  // Chat activity seen after the marker send — armed just before sendText so pairing-time history
  // sync can't satisfy the round-trip check.
  let watchingActivity = false;
  const activityAfterSend: ChatMeta[] = [];

  const client = new WhatsappClient({
    authDir: SESSION_DIR,
    secretStore,
    appVersion: '0.0.0-smoke',
    deviceName: 'Stewra Bridge (smoke)',
    events: {
      onOpen: (identity) => {
        opened.identity = identity;
      },
      onState: (state, message) => {
        lastState = state;
        open = state === 'open';
        console.log(`     [state] ${state}${message !== undefined ? ` — ${message}` : ''}`);
      },
      onMessage: (message) => {
        received.push(message);
      },
      onQr: (qrDataUrl) => {
        const png = Buffer.from(qrDataUrl.slice('data:image/png;base64,'.length), 'base64');
        void writeFile(QR_PATH, png).then(() => {
          console.log(`     [qr] scan now: open ${QR_PATH} (WhatsApp → Linked Devices → Link a device)`);
        });
      },
      onSessionDestroyed: () => {
        console.log('     [session] destroyed — WhatsApp ended this link; delete .smoke-session and re-pair');
      },
      onChatsMeta: (update) => {
        if (watchingActivity) activityAfterSend.push(...(update.chats ?? []));
      },
    },
  });

  await client.connect();
  // Generous ceiling: a first run waits for a human to scan; a resumed session opens in seconds.
  await until(() => open, 180_000, `the connection to open (last state: ${lastState || 'none'})`);

  check('connection opened', open);
  check('onOpen delivered an identity before the open state', opened.identity !== undefined);
  const ownJid = client.ownJid;
  check('ownJid getter agrees with the onOpen identity', ownJid !== null && ownJid === opened.identity?.ownJid);
  console.log(`     [identity] ${ownJid ?? '(none)'} lid=${opened.identity?.ownLid ?? '(none)'}`);
  if (ownJid === null) throw new Error('no own JID after open — cannot address the self-chat');

  // The round trip: send a marker to the self-chat, then watch WhatsApp echo it back through
  // `messages.upsert`. A device's OWN send comes back as an `append` batch, which waMapping
  // deliberately never turns into a live message (the anti-echo-loop rule) — so the echo is only
  // observable as chat activity on the self-chat, and the live path must stay silent.
  const marker = `stewra-smoke ${new Date().toISOString()}`;
  watchingActivity = true;
  const sentId = await client.sendText(ownJid, marker, null);
  check('sendText returned a provider message id', sentId.length > 0);

  // A null ownLid never matches: meta.id is a string.
  const isSelfChat = (meta: ChatMeta): boolean =>
    meta.id === ownJid || meta.id === opened.identity?.ownLid;
  await until(
    () => activityAfterSend.some(isSelfChat),
    30_000,
    'the send to echo back through messages.upsert as self-chat activity',
  );
  check('the echo surfaced as self-chat activity via onChatsMeta', activityAfterSend.some(isSelfChat));
  check(
    "the marker never became a live message (the 'append' anti-echo filter held)",
    !received.some((m) => m.text === marker),
  );

  client.stop();
  console.log(`\n== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ==\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// Unlink this driver's own pairing from the account. Raw Baileys rather than WhatsappClient because
// the client deliberately has no logout API (see the header) — this is the one place it is correct.
async function logout(): Promise<void> {
  console.log('\n== Unlinking the smoke device ==\n');
  const auth = await useEncryptedAuthState(SESSION_DIR, secretStore);
  if (!auth.state.creds.me) {
    throw new Error(`no paired session in ${SESSION_DIR} — nothing to log out`);
  }
  console.log(`     [device] ${auth.state.creds.me.id}`);

  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: auth.state,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    fireInitQueries: false,
    browser: ['Stewra Bridge (smoke)', 'Desktop', '0.0.0-smoke'],
    getMessage: async () => undefined,
  });
  sock.ev.on('creds.update', () => {
    void auth.saveCreds();
  });

  let open = false;
  let closeReason: string | undefined;
  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') open = true;
    if (connection === 'close') closeReason = String(lastDisconnect?.error ?? 'closed');
  });
  await until(
    () => open || closeReason !== undefined,
    60_000,
    'the connection to open for logout',
  );
  if (!open) throw new Error(`connection closed before logout could be sent: ${closeReason}`);

  await sock.logout();
  await auth.clear();
  console.log(`\nDone: the device is unlinked from the account and ${SESSION_DIR} is deleted.\n`);
  process.exit(0);
}

const run = process.argv.includes('--logout') ? logout : main;
run().catch((err: unknown) => {
  console.error('\nSMOKE ERROR:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
