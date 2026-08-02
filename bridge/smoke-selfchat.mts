// Live WhatsApp smoke driver for the socket shell that no offline test can honestly cover: the real
// `makeWASocket` wiring, a real `sendText`, and the live pairing flow (including WhatsApp's 515
// restart-after-scan). Drives the REAL WhatsappClient against WhatsApp's REAL servers with a QA
// account (see the repo's .env.e2e note) — everything else in bridge/src/core is covered offline.
//
// Run it by hand — NEVER in CI (it talks to WhatsApp's production servers with a real account):
//   cd bridge && npx tsx smoke-selfchat.mts
//
// First run: a QR PNG is written to bridge/.smoke-session/qr.png — open it and scan from the QA
// phone (WhatsApp → Linked Devices → Link a device). The session persists in bridge/.smoke-session/
// (gitignored — it holds REAL linked-device credentials), so later runs are hands-off.
// Unlink afterwards from the phone: Linked Devices → "Stewra Bridge" → Log out.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { WhatsappClient } from './src/core/whatsapp.js';
import type { WhatsappMessage } from './src/core/whatsapp.js';
import type { SecretStore } from './src/core/authState.js';

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

  const client = new WhatsappClient({
    authDir: SESSION_DIR,
    secretStore,
    appVersion: '0.0.0-smoke',
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
      onChatsMeta: () => undefined,
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

  // The round trip: send a marker to the self-chat, then watch the live upsert echo it back through
  // the exact onMessage path bridge.ts consumes.
  const marker = `stewra-smoke ${new Date().toISOString()}`;
  const sentId = await client.sendText(ownJid, marker);
  check('sendText returned a provider message id', sentId.length > 0);

  await until(
    () => received.some((m) => m.fromMe && m.text === marker),
    30_000,
    'the sent marker to echo back through messages.upsert',
  );
  const echo = received.find((m) => m.fromMe && m.text === marker);
  check('marker came back fromMe with the exact text', echo !== undefined);
  check('echoed providerMessageId matches the sendText id', echo?.providerMessageId === sentId);
  check(
    'echo is addressed to the self-chat',
    echo?.remoteJid === ownJid || echo?.remoteJid === opened.identity?.ownLid,
  );

  client.stop();
  console.log(`\n== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ==\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\nSMOKE ERROR:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
