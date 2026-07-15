import makeWASocket, { Browsers, jidNormalizedUser } from '@whiskeysockets/baileys';
import type { WASocket, proto } from '@whiskeysockets/baileys';
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
  /** The 8-character code the user types into WhatsApp → Linked Devices. */
  onPairingCode(code: string): void;
  /** The session is dead and its local credentials have been wiped. The user must pair again. */
  onSessionDestroyed(): void;
}

export interface WhatsappOptions {
  /** Directory holding the encrypted session. Under Electron this is inside `app.getPath('userData')`. */
  readonly authDir: string;
  readonly secretStore: SecretStore;
  readonly events: WhatsappEvents;
}

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
 *  - `browser: Browsers.ubuntu('Stewra Bridge')`. Truthful, on purpose. The user must be able to find us
 *    in WhatsApp → Linked Devices and throw us out from their own phone. Their ability to do that,
 *    without our cooperation, is the strongest safety property this feature has.
 *
 * We do NOT attempt to look like real WhatsApp Web. No evasion, ever — we would be helping a user break a
 * rule while telling them they were safe.
 */
export class WhatsappClient {
  private sock: WASocket | null = null;
  private attempt = 0;
  private replacedAttempt = 0;
  private stopping = false;
  private pendingPhoneNumber: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WhatsappOptions) {}

  /** The user's own JID (`me@s.whatsapp.net`), once connected. Null before that. */
  get ownJid(): string | null {
    const id = this.sock?.user?.id;
    return id === undefined ? null : jidNormalizedUser(id);
  }

  /**
   * Connect (or reconnect) to WhatsApp. Pass a phone number ONLY when pairing a fresh session — an
   * existing session resumes without one, and asking WhatsApp for a pairing code we do not need is
   * exactly the kind of unnecessary noise that makes an account look automated.
   */
  async connect(phoneNumber?: string): Promise<void> {
    this.stopping = false;
    if (phoneNumber !== undefined) this.pendingPhoneNumber = phoneNumber;

    const auth = await useEncryptedAuthState(this.options.authDir, this.options.secretStore);
    const isNewSession = auth.state.creds.registered !== true;

    this.options.events.onState(isNewSession ? 'pairing' : 'connecting');

    const sock = makeWASocket({
      auth: auth.state,
      // ⚠️ See the class comment. `true` silently stops push notifications to the user's real phone.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      // Truthful: this is exactly what the user will see in WhatsApp → Linked Devices.
      browser: Browsers.ubuntu('Stewra Bridge'),
      // We keep no message store, so we cannot re-send an old message on WhatsApp's request. Returning
      // undefined is honest; inventing something here would be worse than a failed retry.
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      void auth.saveCreds();
    });

    // A brand-new session needs the code the user types into their phone. Requested only once, and only
    // when we actually have a number to register.
    if (isNewSession && this.pendingPhoneNumber !== null) {
      const number = this.pendingPhoneNumber;
      this.pendingPhoneNumber = null;
      // WhatsApp wants the socket open before it will mint a code, hence the deferral to the next tick.
      setTimeout(() => {
        void sock
          .requestPairingCode(number.replace(/[^0-9]/g, ''))
          .then((code) => this.options.events.onPairingCode(code))
          .catch(() => {
            this.options.events.onState(
              'disconnected',
              'WhatsApp would not issue a pairing code for that number. Check it and try again.',
            );
          });
      }, 3_000);
    }

    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'open') {
        this.attempt = 0;
        this.replacedAttempt = 0;
        this.options.events.onState('open');
        return;
      }
      if (update.connection === 'close') {
        void this.handleClose(update.lastDisconnect, auth.clear);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      // `append` is history//sync filling in; only `notify` is a message arriving now. Acting on `append`
      // would make Stewra answer messages from days ago the moment a bridge comes online.
      if (type !== 'notify') return;

      for (const message of messages) {
        const remoteJid = message.key.remoteJid;
        const providerMessageId = message.key.id;
        if (remoteJid === null || remoteJid === undefined) continue;
        if (providerMessageId === null || providerMessageId === undefined) continue;

        const text = extractText(message);
        if (text === null) continue; // Media, reactions, receipts — out of scope for v1, and dropped here.

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
  ): Promise<void> {
    if (this.stopping) return;

    const statusCode = extractStatusCode(lastDisconnect?.error);
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
