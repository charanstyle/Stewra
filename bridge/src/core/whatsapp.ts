import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } from '@whiskeysockets/baileys';
import type { WASocket, proto } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import type { BridgeWaState } from '@stewra/shared-types';
import { decideReconnect } from './reconnect.js';
import { useEncryptedAuthState } from './authState.js';
import type { SecretStore } from './authState.js';

/** One WhatsApp message, reduced to what the bridge is willing to look at. */
export interface WhatsappMessage {
  readonly providerMessageId: string;
  readonly remoteJid: string;
  readonly fromMe: boolean;
  readonly text: string;
  readonly sentAt: Date;
}

export interface WhatsappEvents {
  /** State changed. `message` carries the human reason on a terminal state (logged out, banned). */
  onState(state: BridgeWaState, message?: string): void;
  /** A message arrived. NOT yet filtered — the caller runs it through the allowlist gate. */
  onMessage(message: WhatsappMessage): void;
  /**
   * A QR code (a PNG `data:` URL) for the user to scan from their phone: WhatsApp → Linked Devices →
   * Link a device. Re-fired every time WhatsApp rotates the code; the UI just shows the latest.
   */
  onQr(qrDataUrl: string): void;
  /** The session is dead and its local credentials have been wiped. The user must pair again. */
  onSessionDestroyed(): void;
}

export interface WhatsappOptions {
  /** Directory holding the encrypted session. Under Electron this is inside `app.getPath('userData')`. */
  readonly authDir: string;
  readonly secretStore: SecretStore;
  /** The bridge's own version, reported truthfully as the device version in WhatsApp → Linked Devices. */
  readonly appVersion: string;
  readonly events: WhatsappEvents;
}

/**
 * How many fresh QR sessions to open before giving up. WhatsApp rotates the QR a handful of times within
 * one socket (~2 minutes) and then closes it with a 408; each round below re-opens for another ~2 minutes
 * of scanning. Past a few rounds the honest move is to stop and tell the user, not to keep re-registering
 * against WhatsApp forever.
 */
const MAX_QR_ROUNDS = 3;

/** The text of a message, or null for anything we do not handle (media, reactions, protocol messages). */
function extractText(message: proto.IWebMessageInfo): string | null {
  const content = message.message;
  if (!content) return null;
  const text = content.conversation ?? content.extendedTextMessage?.text ?? null;
  return text !== null && text.trim().length > 0 ? text : null;
}

/**
 * The WhatsApp connection — the thing that only ever exists on the user's own computer.
 *
 * Every option in `connect()` below is load-bearing, and two of them are the difference between a bridge
 * that is safe to run and one that quietly damages the user's WhatsApp:
 *
 *  - `markOnlineOnConnect: false`. If this were true, WhatsApp would believe the user is ONLINE on this
 *    device and would STOP SENDING PUSH NOTIFICATIONS TO THEIR REAL PHONE. The user would silently stop
 *    hearing from their friends and would have no idea why. This is not a tuning knob.
 *  - `browser: ['Stewra Bridge', 'Desktop', appVersion]`. Truthful, on purpose, and the FIRST field is
 *    load-bearing: WhatsApp → Linked Devices shows that string as the device name. `Browsers.ubuntu(...)`
 *    put "Ubuntu" there and hid our name, so the user could not tell which device was us. The user must
 *    be able to find us and throw us out from their own phone — that ability, without our cooperation, is
 *    the strongest safety property this feature has, and it depends on this label being honest.
 *
 * We do NOT attempt to look like real WhatsApp Web. No evasion, ever — we would be helping a user break a
 * rule while telling them they were safe.
 */
export class WhatsappClient {
  private sock: WASocket | null = null;
  private attempt = 0;
  private replacedAttempt = 0;
  private stopping = false;
  /** True while we are trying to pair a fresh session (showing QR codes), false once WhatsApp is open. */
  private pairingActive = false;
  private pairingAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WhatsappOptions) {}

  /** The user's own JID (`me@s.whatsapp.net`), once connected. Null before that. */
  get ownJid(): string | null {
    const id = this.sock?.user?.id;
    return id === undefined ? null : jidNormalizedUser(id);
  }

  /**
   * The user's own LID (`…@lid`), once connected — WhatsApp's newer per-account address. Null before that,
   * and null on accounts WhatsApp has not assigned one. The self-chat can arrive addressed by the LID
   * rather than the phone JID, so the allowlist gate needs this to recognise it. Read defensively: the LID
   * is not part of Baileys' published `user` shape in every version, so we do not depend on the type.
   */
  get ownLid(): string | null {
    const user = this.sock?.user;
    if (user === null || user === undefined) return null;
    const lid = Reflect.get(user, 'lid');
    return typeof lid === 'string' && lid.length > 0 ? lid : null;
  }

  /**
   * Connect (or reconnect) to WhatsApp.
   *
   * A fresh session (nothing registered on disk) pairs by QR: WhatsApp emits a code in `connection.update`,
   * we render it, and the user scans it from their phone. An existing session resumes silently — no QR,
   * because asking WhatsApp for pairing material we do not need is exactly the kind of unnecessary noise
   * that makes an account look automated.
   */
  async connect(): Promise<void> {
    this.stopping = false;

    const auth = await useEncryptedAuthState(this.options.authDir, this.options.secretStore);
    const isNewSession = auth.state.creds.registered !== true;
    this.pairingActive = isNewSession;

    this.options.events.onState(isNewSession ? 'pairing' : 'connecting');

    // The WhatsApp Web version baked into a Baileys release goes stale, and WhatsApp refuses
    // registrations from clients it considers outdated — a silent "Connection Failure" loop during
    // pairing. Ask for the current version; if that lookup fails (offline), the baked-in one is the
    // only option left, so say so and try it.
    // `fetchLatestBaileysVersion` never rejects — on any failure it resolves with the library's
    // baked-in version and `isLatest: false`. Surface that fallback, because a stale version is the
    // most likely reason a pairing suddenly stops working.
    const { version, isLatest } = await fetchLatestBaileysVersion();
    if (!isLatest) {
      console.error(
        'Stewra Bridge: could not fetch the current WhatsApp Web version; using the built-in one, ' +
          'which WhatsApp may consider outdated.',
      );
    }

    const sock = makeWASocket({
      version,
      auth: auth.state,
      // ⚠️ See the class comment. `true` silently stops push notifications to the user's real phone.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      // The first field is the device name WhatsApp shows in Linked Devices — it must say who we are.
      // 'Desktop' is the platform type (an icon hint); the third is our version, shown as the device
      // version. See the class comment: this label being honest is what lets the user revoke us.
      browser: ['Stewra Bridge', 'Desktop', this.options.appVersion],
      // We keep no message store, so we cannot re-send an old message on WhatsApp's request. Returning
      // undefined is honest; inventing something here would be worse than a failed retry.
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      void auth.saveCreds();
    });

    sock.ev.on('connection.update', (update) => {
      // A brand-new session gets a QR here, re-emitted every ~20s as WhatsApp rotates it. Rendering it is
      // async (PNG encoding); a QR we cannot render is not fatal — the next rotation will arrive shortly.
      if (update.qr !== undefined && update.qr !== null) {
        void QRCode.toDataURL(update.qr, { margin: 2, width: 320 })
          .then((dataUrl) => this.options.events.onQr(dataUrl))
          .catch(() => undefined);
      }

      if (update.connection === 'open') {
        this.attempt = 0;
        this.replacedAttempt = 0;
        this.pairingActive = false;
        this.pairingAttempt = 0;
        this.options.events.onState('open');
        return;
      }
      if (update.connection === 'close') {
        void this.handleClose(update.lastDisconnect, auth.clear, () => auth.state.creds.registered === true);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      // `append` is history//sync filling in; only `notify` is a message arriving now. Acting on `append`
      // would make Stewra answer messages from days ago the moment a bridge comes online.
      if (type !== 'notify') {
        console.error(
          `Stewra Bridge: ignoring ${messages.length} '${type}' message(s) — only live 'notify' ` +
            'messages are acted on.',
        );
        return;
      }

      for (const message of messages) {
        const remoteJid = message.key.remoteJid;
        const providerMessageId = message.key.id;
        if (remoteJid === null || remoteJid === undefined) continue;
        if (providerMessageId === null || providerMessageId === undefined) continue;

        const text = extractText(message);
        if (text === null) {
          console.error(
            `Stewra Bridge: a non-text message on ${remoteJid} (fromMe=${message.key.fromMe === true}) — ` +
              'out of scope for v1, dropped.',
          );
          continue; // Media, reactions, receipts — out of scope for v1, and dropped here.
        }

        console.error(
          `Stewra Bridge: message on ${remoteJid} (fromMe=${message.key.fromMe === true}) → allowlist gate.`,
        );
        const seconds = Number(message.messageTimestamp ?? 0);
        this.options.events.onMessage({
          providerMessageId,
          remoteJid,
          fromMe: message.key.fromMe === true,
          text,
          sentAt: seconds > 0 ? new Date(seconds * 1000) : new Date(),
        });
      }
    });
  }

  /** Deliver one message. The provider id it returns is what breaks the echo loop on the server. */
  async sendText(jid: string, text: string): Promise<string> {
    const sock = this.sock;
    if (sock === null) throw new Error('WhatsApp is not connected');

    const sent = await sock.sendMessage(jid, { text });
    const id = sent?.key.id;
    if (id === null || id === undefined) {
      throw new Error('WhatsApp accepted the message but returned no id');
    }
    return id;
  }

  /**
   * Shut the socket down.
   *
   * ⚠️ `sock.end()`, NEVER `sock.logout()`. `logout()` PERMANENTLY UNLINKS the device from the user's
   * WhatsApp account — quitting the app would silently destroy their session and force a re-pair every
   * single launch. One method name apart, unrecoverable, and the user would blame the ban warning.
   */
  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sock?.end(undefined);
    this.sock = null;
    this.options.events.onState('disconnected');
  }

  /** Destroy the local session for good: the user revoked this device, or WhatsApp threw us out. */
  async destroySession(): Promise<void> {
    this.stop();
    const auth = await useEncryptedAuthState(this.options.authDir, this.options.secretStore);
    await auth.clear();
    this.options.events.onSessionDestroyed();
  }

  /** Apply the disconnect table. Everything hard about this lives in `decideReconnect`, which is pure. */
  private async handleClose(
    lastDisconnect: { error?: Error | undefined } | undefined,
    clearCredentials: () => Promise<void>,
    isRegistered: () => boolean,
  ): Promise<void> {
    if (this.stopping) return;

    const statusCode = extractStatusCode(lastDisconnect?.error);
    // The one line that turns "it is not working" into a diagnosis. Baileys' own log says only
    // "Connection Failure"; the status code is the actual reason WhatsApp gave.
    console.error(
      `Stewra Bridge: WhatsApp connection closed (status ${statusCode ?? 'unknown'}):`,
      lastDisconnect?.error?.message ?? 'no error reported',
    );

    // A close in the middle of pairing means the QR on screen expired with the socket (WhatsApp cycles a
    // few QR refs, ~2 minutes, then closes with a 408 "QR refs attempts ended"). The disconnect table
    // below must NOT see this: an unscanned QR half-populates the credentials, so a plain reconnect would
    // try to LOG IN with them and draw a terminal 401. Wipe the partial registration and register again
    // from scratch, which puts a fresh QR on screen.
    //
    // ⚠️ EXCEPT a 515 (restartRequired). WhatsApp sends exactly that the instant a scan SUCCEEDS —
    // "pairing configured successfully, expect to restart the connection". At that moment the creds are
    // freshly registered but `registered` may not have flushed to our in-memory view yet, so this branch
    // would otherwise wipe a link that just worked and loop forever on a new QR. A 515 is the pairing
    // completing; hand it to `decideReconnect`, which reconnects immediately and logs in.
    if (statusCode !== DisconnectReason.restartRequired && !isRegistered() && this.pairingActive) {
      await clearCredentials();
      this.pairingAttempt += 1;
      if (this.pairingAttempt >= MAX_QR_ROUNDS) {
        this.pairingActive = false;
        this.pairingAttempt = 0;
        this.options.events.onState(
          'disconnected',
          'The QR code expired before it was scanned, several times over. Click "Link WhatsApp" to show a fresh one, and scan it from WhatsApp → Linked Devices right away — each code only lives a couple of minutes.',
        );
        return;
      }
      this.options.events.onState('pairing');
      this.reconnectTimer = setTimeout(() => {
        void this.connect().catch(() => {
          this.options.events.onState('disconnected', 'Stewra Bridge could not reach WhatsApp.');
        });
      }, 1_000);
      return;
    }

    const decision = decideReconnect({
      statusCode,
      attempt: this.attempt,
      replacedAttempt: this.replacedAttempt,
    });

    if (decision.kind === 'stop') {
      if (decision.wipeCredentials) {
        await clearCredentials();
        this.options.events.onSessionDestroyed();
      }
      this.options.events.onState(decision.waState, decision.message);
      return;
    }

    if (decision.countsAsAttempt) this.attempt += 1;
    if (statusCode === 440) this.replacedAttempt += 1;

    this.options.events.onState('connecting');
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch(() => {
        this.options.events.onState('disconnected', 'Stewra Bridge could not reach WhatsApp.');
      });
    }, decision.delayMs);
  }
}

/** Baileys reports the reason as a Boom error; the code is the only part of it we act on. */
function extractStatusCode(error: Error | undefined): number | undefined {
  if (error === undefined) return undefined;
  const output = Reflect.get(error, 'output');
  if (typeof output !== 'object' || output === null) return undefined;
  const statusCode = Reflect.get(output, 'statusCode');
  return typeof statusCode === 'number' ? statusCode : undefined;
}
