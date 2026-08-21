import makeWASocket, {
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import type { proto, WAMessage, WASocket } from '@whiskeysockets/baileys';
import type { BridgeWaState } from '@stewra/shared-types';
import { decideCloseAction } from './closePolicy.js';
import { useEncryptedAuthState } from './authState.js';
import type { SecretStore } from './authState.js';
import type { ChatMeta } from './chatDirectory.js';
import { RecentMessages } from './recentMessages.js';
import { extractLid, extractStatusCode, lidFromUsync, mapUpsert, metas, renderQr } from './waMapping.js';
import type { WhatsappMessage } from './waMapping.js';

export type { VoiceNote, WhatsappMessage } from './waMapping.js';

/**
 * The largest voice note the bridge will download and forward. The server's socket rejects frames
 * above its own buffer limit by DROPPING THE CONNECTION, so the cap is enforced here first, where it
 * can be logged instead. 3 MiB of OGG/Opus at WhatsApp's bitrate is well over twenty minutes of speech.
 */
export const MAX_VOICE_NOTE_BYTES = 3 * 1024 * 1024;

/**
 * How many live messages are kept so Stewra's replies can quote them. Generous against the real
 * rate of a self-chat plus a few ticked chats; what matters is that the message being answered —
 * seconds to minutes old — is still here. See `recentMessages.ts` for why it is bounded at all.
 */
export const RECENT_MESSAGES_KEPT = 500;

export interface WhatsappEvents {
  /**
   * WhatsApp opened AND told us who we are. Fired before `onState('open')`, so the allowlist gate
   * exists by the time anyone reacts to the state change. Identity arrives as data on purpose: the
   * consumer never has to reach into a live socket to learn it.
   */
  onOpen(identity: { readonly ownJid: string; readonly ownLid: string | null }): void;
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
  /**
   * Chat/contact metadata arrived — the history snapshot on link, chat and contact upserts, renames,
   * and live message activity. Feeds the LOCAL chat directory behind the picker; nothing on this path
   * leaves the machine. Baileys keeps no store and full history sync is off, so this is deliberately
   * best-effort — every chat that messages while the bridge runs becomes pickable, and the UI says so.
   */
  onChatsMeta(update: { readonly chats?: readonly ChatMeta[]; readonly contacts?: readonly ChatMeta[] }): void;
}

export interface WhatsappOptions {
  /** Directory holding the encrypted session. Under Electron this is inside `app.getPath('userData')`. */
  readonly authDir: string;
  readonly secretStore: SecretStore;
  /** The bridge's own version, reported truthfully as the device version in WhatsApp → Linked Devices. */
  readonly appVersion: string;
  /**
   * The device name WhatsApp shows in Linked Devices. Defaults to the product name; the smoke driver
   * overrides it so a test pairing is tellable from the real one on the phone — the list shows only
   * this name, never the version. Whatever it says, it must say who we are (see the class comment).
   */
  readonly deviceName?: string;
  readonly events: WhatsappEvents;
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
 *
 * All the decisions live in pure modules (`waMapping.ts`, `closePolicy.ts`, `reconnect.ts`) with their
 * own tests; this class is the shell that feeds them from `sock.ev` and applies what they return.
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
  /** Live messages by id, so a reply can quote the message it answers (see `quoteOptions`). */
  private readonly recent = new RecentMessages<WAMessage>(RECENT_MESSAGES_KEPT);
  /**
   * What this bridge has SENT, by id — the only thing it can honestly re-send when WhatsApp asks (see
   * `getMessage`). Separate from `recent` on purpose: that one holds other people's messages so a reply
   * can quote them, and the two must never be confused for one another.
   */
  private readonly sentMessages = new RecentMessages<proto.IMessage>(RECENT_MESSAGES_KEPT);

  constructor(private readonly options: WhatsappOptions) {}

  /** The user's own JID (`me@s.whatsapp.net`), once connected. Null before that. */
  get ownJid(): string | null {
    const id = this.sock?.user?.id;
    return id === undefined ? null : jidNormalizedUser(id);
  }

  /**
   * The user's own LID (`…@lid`), once connected — WhatsApp's newer per-account address. Null before
   * that, and null on accounts WhatsApp has not assigned one. The self-chat can arrive addressed by the
   * LID rather than the phone JID, so the allowlist gate needs this to recognise it.
   */
  get ownLid(): string | null {
    const user = this.sock?.user;
    if (user === null || user === undefined) return null;
    return extractLid(user);
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
      // Skip the three post-connect "init queries" (props, blocklist, privacy settings): the Bridge
      // consumes none of their results, and WhatsApp's servers no longer answer the props form this
      // Baileys version sends (xmlns 'w'/protocol '2' — reworked upstream only in 7.0.0-rc), so it
      // times out with a logged 408 sixty seconds after every connect. Remove when Baileys 7 lands.
      fireInitQueries: false,
      // The first field is the device name WhatsApp shows in Linked Devices — it must say who we are.
      // 'Desktop' is the platform type (an icon hint); the third is our version, shown as the device
      // version. See the class comment: this label being honest is what lets the user revoke us.
      browser: [this.options.deviceName ?? 'Stewra Bridge', 'Desktop', this.options.appVersion],
      // WhatsApp asks for this when a device could not decrypt something we sent and wants it again.
      // Answer it for our OWN sends, which we hold in `sentMessages`.
      //
      // ⚠️ NOT optional, and returning `undefined` unconditionally — which this did — breaks the product
      // in a way nothing else reports. Measured on the linked iPhone (2026-08-21): Stewra's reply left
      // here, WhatsApp accepted it and reported it delivered, and the phone rendered "Waiting for this
      // message. This may take a while." — permanently. The phone asks for a re-send exactly once and
      // gives up; with nothing to give it, every reply this bridge sent was unreadable while every log
      // line said success. With the store in place the same exchange re-sends and renders. The self-chat
      // is the one conversation where this always bites: a companion device pairs with no prior session
      // to the phone, so the FIRST message each way needs the retry.
      //
      // Anything we have not sent is still `undefined`: we keep no store of other people's messages and
      // will not invent one.
      getMessage: async (key) => {
        const id = key.id;
        if (id === null || id === undefined) {
          console.error('Stewra Bridge: a device asked for a message again but named no id; nothing to re-send.');
          return undefined;
        }
        const ours = this.sentMessages.get(id);
        // Logged either way, and loudly: this ask is the ONLY signal that a reply landed unreadable, and
        // without it the failure is invisible here and permanent on the phone.
        console.error(
          `Stewra Bridge: ${key.remoteJid ?? 'a device'} could not read message ${id} and asked for it ` +
            (ours === null
              ? 'again — this bridge does not hold it (sent before this run started), so it stays ' +
                'unreadable on their phone.'
              : 'again — re-sending it.'),
        );
        return ours === null ? undefined : ours;
      },
    });
    this.sock = sock;

    // Who we are, as last announced. WhatsApp does not always hand over the LID in the open handshake:
    // a session linked by pairing code opens with `me.id` only and the LID lands moments later through
    // `creds.update`. Meanwhile the phone addresses the self-chat BY that LID — so a gate built from the
    // open-time identity drops the user's own first message as "not_allowed". Re-announce when the
    // identity grows, and the Bridge rebuilds the gate (handleWaOpen is idempotent).
    let announced: { ownJid: string; ownLid: string | null } | null = null;
    /** The LID as the directory answered it, when the handshake carried none. See `learnOwnLid`. */
    let lookedUpLid: string | null = null;
    const announceIdentity = (): void => {
      const user = sock.user;
      if (user === null || user === undefined || user.id.length === 0) return;
      const fromHandshake = extractLid(user);
      const identity = {
        ownJid: jidNormalizedUser(user.id),
        // Both sources are WhatsApp's own answer about THIS account — the handshake's, or the directory
        // lookup below when the handshake had nothing. Neither is inferred from a message we received.
        ownLid: fromHandshake === null ? lookedUpLid : fromHandshake,
      };
      if (announced !== null && announced.ownJid === identity.ownJid && announced.ownLid === identity.ownLid) return;
      announced = identity;
      this.options.events.onOpen(identity);
    };

    /**
     * Ask WhatsApp for this account's own LID when neither the handshake nor `creds.update` produced one.
     *
     * Measured on a QR-linked session (2026-08-21): the socket opened as `<number>@s.whatsapp.net` with no
     * LID at all, and none ever arrived — while the user's phone addressed the "Message yourself" chat by
     * LID. The gate could not recognise the self-chat, so every message the user sent themselves was
     * dropped on this machine and Stewra answered nothing. A pairing-code session on the same build got
     * its LID in the handshake, which is why this went unseen until a real QR link.
     *
     * `onWhatsApp` is a USync directory query — WhatsApp telling us the LID for a number. If it answers
     * with none, the capability is DROPPED and said out loud; nothing is guessed in its place, because a
     * wrong self-identity would hand someone else's chat to Stewra as if it were the user's own.
     */
    const learnOwnLid = async (): Promise<void> => {
      const user = sock.user;
      if (user === null || user === undefined || user.id.length === 0) return;
      if (extractLid(user) !== null) return;

      const ownJid = jidNormalizedUser(user.id);
      const lid = lidFromUsync(await sock.onWhatsApp(ownJid), ownJid);
      if (lid === null) {
        console.error(
          `Stewra Bridge: WhatsApp reported no LID for ${ownJid}. If this account's phone addresses the ` +
            'self-chat by LID, those messages cannot be recognised as the self-chat and will be dropped ' +
            '— each one logged by the allowlist gate.',
        );
        return;
      }
      console.error(`Stewra Bridge: ${ownJid} is also ${lid} (asked WhatsApp; the handshake carried no LID).`);
      lookedUpLid = lid;
      announceIdentity();
    };

    sock.ev.on('creds.update', () => {
      void auth.saveCreds();
      if (announced !== null) announceIdentity();
    });

    sock.ev.on('connection.update', (update) => {
      // A brand-new session gets a QR here, re-emitted every ~20s as WhatsApp rotates it. Rendering it is
      // async (PNG encoding); a QR we cannot render is not fatal — the next rotation will arrive shortly.
      if (update.qr !== undefined && update.qr !== null) {
        void renderQr(update.qr).then((dataUrl) => {
          if (dataUrl !== null) this.options.events.onQr(dataUrl);
        });
      }

      if (update.connection === 'open') {
        this.attempt = 0;
        this.replacedAttempt = 0;
        this.pairingActive = false;
        this.pairingAttempt = 0;
        announceIdentity();
        this.options.events.onState('open');
        // Not awaited: 'open' must not wait on a directory round-trip. A rejection here is a broken
        // socket, and Baileys' own close handling is what answers that.
        void learnOwnLid();
        return;
      }
      if (update.connection === 'close') {
        void this.handleClose(update.lastDisconnect, auth.clear, () => auth.state.creds.registered === true);
      }
    });

    // ── the local chat directory's feeds ─────────────────────────────────────────────────────────────
    // Everything below only ever powers the picker UI on this machine (see onChatsMeta). Baileys hands
    // metadata over in several shapes; waMapping.ts reduces them all to ChatMeta so core/chatDirectory.ts
    // stays free of Baileys types.
    sock.ev.on('messaging-history.set', ({ chats, contacts }) => {
      this.options.events.onChatsMeta({ chats: metas(chats), contacts: metas(contacts) });
    });
    sock.ev.on('chats.upsert', (chats) => this.options.events.onChatsMeta({ chats: metas(chats) }));
    sock.ev.on('chats.update', (updates) => this.options.events.onChatsMeta({ chats: metas(updates) }));
    sock.ev.on('contacts.upsert', (contacts) => this.options.events.onChatsMeta({ contacts: metas(contacts) }));
    sock.ev.on('contacts.update', (updates) => this.options.events.onChatsMeta({ contacts: metas(updates) }));

    sock.ev.on('messages.upsert', (event) => {
      const outcome = mapUpsert(event);

      if (outcome.chatActivity.length > 0) this.options.events.onChatsMeta({ chats: outcome.chatActivity });

      // `append` is history sync filling in; only `notify` is a message arriving now.
      if (!outcome.actedOn) {
        console.error(
          `Stewra Bridge: ignoring ${event.messages.length} '${event.type}' message(s) — only live ` +
            "'notify' messages are acted on.",
        );
        return;
      }

      // Every live message is remembered — text, voice note, or something we drop — because any of
      // them may be what Stewra's next line answers, and Baileys can only quote the original object.
      for (const raw of event.messages) {
        const id = raw.key.id;
        if (id !== null && id !== undefined && id.length > 0) this.recent.remember(id, raw);
      }

      for (const drop of outcome.dropped) {
        console.error(
          `Stewra Bridge: a non-text message on ${drop.remoteJid} (fromMe=${drop.fromMe}) — ` +
            'out of scope for v1, dropped.',
        );
      }
      for (const message of outcome.live) {
        if (message.voice === null) {
          console.error(
            `Stewra Bridge: message on ${message.remoteJid} (fromMe=${message.fromMe}) → allowlist gate.`,
          );
          this.options.events.onMessage(message);
          continue;
        }
        // A voice note: fetch and decrypt the bytes here, on this machine, then hand it to the same gate.
        // The download is async; a failure is logged and the note is dropped — nothing is forwarded that
        // we could not read.
        const { raw, mime, seconds } = message.voice;
        void this.downloadVoiceNote(raw)
          .then((data) => {
            if (data.byteLength > MAX_VOICE_NOTE_BYTES) {
              console.error(
                `Stewra Bridge: a voice note on ${message.remoteJid} is ${data.byteLength} bytes, over the ` +
                  `${MAX_VOICE_NOTE_BYTES}-byte limit — dropped.`,
              );
              return;
            }
            console.error(
              `Stewra Bridge: voice note on ${message.remoteJid} (fromMe=${message.fromMe}, ${mime}, ` +
                `${data.byteLength} bytes) → allowlist gate.`,
            );
            this.options.events.onMessage({
              providerMessageId: message.providerMessageId,
              remoteJid: message.remoteJid,
              fromMe: message.fromMe,
              sentAt: message.sentAt,
              text: null,
              voice: { data, mime, seconds },
            });
          })
          .catch((error: unknown) => {
            console.error(`Stewra Bridge: could not download a voice note on ${message.remoteJid}:`, error);
          });
      }
    });
  }

  /** Fetch and decrypt one media message's bytes. Baileys streams or buffers; we only ever want the buffer. */
  private async downloadVoiceNote(raw: WAMessage): Promise<Buffer> {
    const result = await downloadMediaMessage(raw, 'buffer', {});
    if (!Buffer.isBuffer(result)) throw new Error('Baileys returned a stream for a buffer download');
    return result;
  }

  /**
   * Deliver a voice note — audio the recipient sees as a recorded message with a play button, not as a
   * file. OGG/Opus is what WhatsApp itself records, and the only container that renders as a voice note
   * on every client; the server transcodes to it before asking.
   *
   * `replyTo` (a message id this bridge has seen) makes it a WhatsApp reply quoting that message.
   */
  async sendVoiceNote(jid: string, audio: Buffer, replyTo: string | null): Promise<string> {
    const sock = this.sock;
    if (sock === null) throw new Error('WhatsApp is not connected');

    const sent = await sock.sendMessage(
      jid,
      { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true },
      this.quoteOptions(replyTo),
    );
    const id = sent?.key.id;
    if (id === null || id === undefined) {
      throw new Error('WhatsApp accepted the voice note but returned no id');
    }
    this.rememberSent(id, sent?.message);
    return id;
  }

  /**
   * Deliver one message. The provider id it returns is what breaks the echo loop on the server.
   * `replyTo` (a message id this bridge has seen) makes it a WhatsApp reply quoting that message.
   */
  async sendText(jid: string, text: string, replyTo: string | null): Promise<string> {
    const sock = this.sock;
    if (sock === null) throw new Error('WhatsApp is not connected');

    const sent = await sock.sendMessage(jid, { text }, this.quoteOptions(replyTo));
    const id = sent?.key.id;
    if (id === null || id === undefined) {
      throw new Error('WhatsApp accepted the message but returned no id');
    }
    this.rememberSent(id, sent?.message);
    return id;
  }

  /**
   * Hold on to what we just sent, so a device that could not decrypt it can be answered.
   *
   * A send with no content on it is the one case worth shouting about rather than storing: WhatsApp
   * took the message, the recipient may well fail to decrypt it, and we would then have nothing to
   * re-send and no idea why. Say so now, while the send is still on screen.
   */
  private rememberSent(id: string, content: proto.IMessage | null | undefined): void {
    if (content === null || content === undefined) {
      console.error(
        `Stewra Bridge: WhatsApp returned message ${id} with no content; if the recipient asks for it ` +
          'again there is nothing to re-send.',
      );
      return;
    }
    this.sentMessages.remember(id, content);
  }

  /**
   * The `quoted` option for a reply, or nothing for a plain send.
   *
   * A quote Stewra asked for that this bridge cannot honour — the message arrived before the bridge
   * last started, so it was never held — is a FAILED send, reported as such. Posting the line unquoted
   * would put Stewra's words in the self-chat looking exactly like the person's own; the server records
   * the failure and the person sees a gap rather than a bubble that lies about who wrote it.
   */
  private quoteOptions(replyTo: string | null): { quoted: WAMessage } | undefined {
    if (replyTo === null) return undefined;
    const quoted = this.recent.get(replyTo);
    if (quoted === null) {
      throw new Error(
        `quoted_message_unknown: Stewra asked to quote message ${replyTo}, which this bridge has not ` +
          'seen since it started',
      );
    }
    return { quoted };
  }

  /**
   * Shut the socket down.
   *
   * ⚠️ `sock.end()`, NEVER `sock.logout()`. `logout()` PERMANENTLY UNLINKS the device from the user's
   * WhatsApp account — quitting the app would silently destroy their session and force a re-pair every
   * single launch. One method name apart, unrecoverable, and the user would blame the ban warning.
   * (Enforced statically: eslint bans the `logout` property throughout bridge/src/core.)
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

  /** Apply the close table. Everything hard about it lives in `decideCloseAction`, which is pure. */
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
      `Stewra Bridge: WhatsApp connection closed (status ${statusCode ?? 'unknown'}):`, // fallback-ok: log copy, not a value any caller reads
      lastDisconnect?.error?.message ?? 'no error reported',
    );

    const action = decideCloseAction({
      statusCode,
      isRegistered: isRegistered(),
      pairingActive: this.pairingActive,
      pairingAttempt: this.pairingAttempt,
      attempt: this.attempt,
      replacedAttempt: this.replacedAttempt,
    });

    switch (action.kind) {
      case 'wipe-and-retry':
        await clearCredentials();
        this.pairingAttempt = action.nextPairingAttempt;
        this.options.events.onState('pairing');
        this.scheduleReconnect(action.delayMs);
        return;
      case 'pairing-give-up':
        await clearCredentials();
        this.pairingActive = false;
        this.pairingAttempt = 0;
        this.options.events.onState('disconnected', action.message);
        return;
      case 'stop':
        if (action.wipeCredentials) {
          await clearCredentials();
          this.options.events.onSessionDestroyed();
        }
        this.options.events.onState(action.waState, action.message);
        return;
      case 'reconnect':
        if (action.countsAsAttempt) this.attempt += 1;
        if (action.bumpReplaced) this.replacedAttempt += 1;
        this.options.events.onState('connecting');
        this.scheduleReconnect(action.delayMs);
        return;
    }
  }

  private scheduleReconnect(delayMs: number): void {
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch(() => {
        this.options.events.onState('disconnected', 'Stewra Bridge could not reach WhatsApp.');
      });
    }, delayMs);
  }
}
