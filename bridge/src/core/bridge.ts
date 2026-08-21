import type { BridgeAllowedChat, BridgeSendAck, BridgeSendPayload, BridgeWaState } from '@stewra/shared-types';
import { AllowlistGate } from './allowlist.js';
import { ChatDirectory } from './chatDirectory.js';
import type { ChatMeta, ChatSummary } from './chatDirectory.js';
import type { BridgeConfig } from './config.js';
import { StewraClient } from './stewraClient.js';
import { WhatsappClient } from './whatsapp.js';
import type { SecretStore } from './authState.js';
import type { WhatsappMessage } from './whatsapp.js';

export interface BridgeEvents {
  /** Surfaced in the app window and the tray. `message` is the human reason, when there is one. */
  onState(state: BridgeWaState, message?: string): void;
  /** A QR code (PNG `data:` URL) for the user to scan from WhatsApp → Linked Devices → Link a device. */
  onQr(qrDataUrl: string): void;
  /** The WhatsApp session is gone (logged out or banned) and its local credentials have been wiped. */
  onSessionDestroyed(): void;
  /**
   * The user revoked THIS DEVICE from the Stewra web app. Distinct from `onSessionDestroyed` on purpose:
   * here the device's Stewra token is dead too, so the app must throw the token away and send the user
   * back for a fresh pairing code. A WhatsApp logout leaves the token perfectly valid and needs only a
   * re-link — collapsing the two would make one of those recoveries wrong.
   */
  onRevoked(): void;
  /**
   * The local chat directory changed (new chat seen, rename, fresh activity). Debounced; the shell
   * re-reads `getChats()` and repaints the picker. Purely local — nothing about this event, or the
   * directory behind it, is sent anywhere.
   */
  onChatsChanged(): void;
  /**
   * The Stewra socket came up or went down. Deliberately separate from `onState` (which is WhatsApp's):
   * WhatsApp open with Stewra unreachable is the one shape where the bridge looks alive while every
   * forwarded message is being dropped (see `StewraClient.inbound`), and the UI must not call that
   * "connected".
   */
  onStewraConnection(connected: boolean): void;
}

export interface BridgeOptions {
  readonly config: BridgeConfig;
  readonly authDir: string;
  readonly secretStore: SecretStore;
  readonly events: BridgeEvents;
  /**
   * How long to coalesce chat-directory bursts before one `onChatsChanged` repaint. A behaviour knob
   * (default 1s); tests pass a short real value and await it — never a faked clock.
   */
  readonly chatsChangedDebounceMs?: number;
}

/**
 * The bridge itself: WhatsApp on one side, Stewra on the other, with the allowlist gate in between.
 *
 * The ordering in `handleMessage` is the whole design in four lines. The gate runs FIRST, on the user's
 * own machine, before anything is serialised and before any socket is touched. A chat the user has not
 * ticked does not get redacted or filtered later — it never becomes a network call at all.
 */
export class Bridge {
  private readonly whatsapp: WhatsappClient;
  private readonly stewra: StewraClient;
  private gate: AllowlistGate | null = null;
  private waState: BridgeWaState = 'disconnected';
  /** The chats the user ticked in this app. The self-chat is not in here; it is unconditional. */
  private tickedChats: BridgeAllowedChat[] = [];
  /** Every chat this machine has seen — the picker's data source. Local only, never synced. */
  private readonly directory = new ChatDirectory();
  private chatsChangedTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: BridgeOptions) {
    this.whatsapp = new WhatsappClient({
      authDir: options.authDir,
      secretStore: options.secretStore,
      appVersion: options.config.appVersion,
      events: {
        onOpen: (identity) => this.handleWaOpen(identity),
        onState: (state, message) => this.handleWaState(state, message),
        onMessage: (message) => this.handleWaMessage(message),
        onQr: (qrDataUrl) => options.events.onQr(qrDataUrl),
        onSessionDestroyed: () => options.events.onSessionDestroyed(),
        onChatsMeta: (update) => this.handleWaChatsMeta(update),
      },
    });

    this.stewra = new StewraClient(options.config, {
      onSend: (payload) => this.handleSend(payload),
      onRevoked: () => {
        // The user revoked this machine from the web app. Stewra cannot reach into their WhatsApp account
        // and unlink us — that session lives here — so the honest thing is to destroy it ourselves, now.
        void this.whatsapp.destroySession();
        this.stewra.disconnect();
        options.events.onRevoked();
      },
      onConnected: () => {
        this.stewra.hello(this.waState);
        options.events.onStewraConnection(true);
      },
      onDisconnected: () => options.events.onStewraConnection(false),
    });
  }

  /** Start: connect to Stewra with the saved token, then bring up WhatsApp. */
  async start(token: string): Promise<void> {
    this.connectStewra(token);
    await this.connectWhatsapp();
  }

  /** Bring up the Stewra side alone. Split from `start` so tests can run it against a loopback server. */
  connectStewra(token: string): void {
    this.stewra.connect(token);
  }

  /** Bring up the WhatsApp side alone. Always hits the real WhatsApp servers — the smoke layer's territory. */
  async connectWhatsapp(): Promise<void> {
    await this.whatsapp.connect();
  }

  stop(): void {
    if (this.chatsChangedTimer !== null) {
      clearTimeout(this.chatsChangedTimer);
      this.chatsChangedTimer = null;
    }
    this.whatsapp.stop();
    this.stewra.disconnect();
  }

  /** The user ticked or unticked chats. Takes effect immediately, on this machine and on the server. */
  setTickedChats(chats: readonly BridgeAllowedChat[]): void {
    this.tickedChats = [...chats];
    this.gate?.setAllowed(this.tickedChats);
    this.syncAllowedChats();
  }

  /**
   * The pickable chats, most recent first. The self-chat is excluded — it is pinned "always on" in the
   * UI, not a row the user can untick (unticking it would just be a broken bridge).
   */
  getChats(): ChatSummary[] {
    return this.directory.list().filter((chat) => !(this.gate?.isSelfChat(chat.jid) ?? false));
  }

  /** Snapshot of the directory for the encrypted local cache (so the picker survives a restart). */
  serializeChatDirectory(): string {
    return this.directory.serialize();
  }

  /** Restore a `serializeChatDirectory` snapshot. Additive; live events keep layering on top. */
  hydrateChatDirectory(json: string): void {
    this.directory.hydrate(json);
  }

  /** Debounce: history sync delivers hundreds of events in bursts, and one repaint is enough. */
  private scheduleChatsChanged(): void {
    if (this.chatsChangedTimer !== null) return;
    this.chatsChangedTimer = setTimeout(() => {
      this.chatsChangedTimer = null;
      this.options.events.onChatsChanged();
    }, this.options.chatsChangedDebounceMs ?? 1_000);
  }

  /**
   * WhatsApp opened and reported who we are — the WhatsApp-event entry point for identity. Public so
   * tests can drive the real pipeline with real event data; in production only the constructor wiring
   * calls it. The gate is (re)built here, before anyone reacts to the 'open' state.
   */
  handleWaOpen(identity: { readonly ownJid: string; readonly ownLid: string | null }): void {
    // The LID matters because WhatsApp addresses the self-chat by it on some clients; logging both here
    // is what let us diagnose a self-message being dropped as "not_allowed" when it arrived as a LID.
    console.error(
      `Stewra Bridge: WhatsApp open as ${identity.ownJid}` +
        `${identity.ownLid !== null ? ` (lid ${identity.ownLid})` : ''}.`,
    );
    this.gate = new AllowlistGate(identity.ownJid, identity.ownLid ?? undefined);
    this.gate.setAllowed(this.tickedChats);
    this.syncAllowedChats();
  }

  /** WhatsApp state changed — a WhatsApp-event entry point (public for the same reason as above). */
  handleWaState(state: BridgeWaState, message?: string): void {
    this.waState = state;
    // Tell the server, so the web app's status dot is the truth rather than a guess.
    this.stewra.state(state);
    this.options.events.onState(state, message);
  }

  /** Chat/contact metadata arrived — a WhatsApp-event entry point (public for the same reason as above). */
  handleWaChatsMeta(update: { readonly chats?: readonly ChatMeta[]; readonly contacts?: readonly ChatMeta[] }): void {
    if (update.chats !== undefined) this.directory.applyChats(update.chats);
    if (update.contacts !== undefined) this.directory.applyContacts(update.contacts);
    this.scheduleChatsChanged();
  }

  private syncAllowedChats(): void {
    if (this.gate === null) return;
    // The self-chat is always in this list, so it is never empty — which is exactly what the server
    // requires, because an empty allowlist means "a bridge is broken", never "delete everything".
    this.stewra.allowedChats(this.gate.toSyncPayload('You'));
  }

  /**
   * A message arrived on WhatsApp. THE GATE RUNS HERE, on the user's computer, before the network.
   *
   * If the user has not ticked this chat, the function returns. Stewra's servers never learn that the
   * message existed, never learn who sent it, never learn that the chat exists at all. There is no
   * `fetch` on this path to accidentally leave in — that is what makes the promise checkable.
   *
   * A WhatsApp-event entry point, public so tests can prove exactly that promise on a real wire.
   */
  handleWaMessage(message: WhatsappMessage): void {
    if (this.gate === null) {
      console.error('Stewra Bridge: a message arrived before WhatsApp finished connecting; dropped.');
      return;
    }

    const decision = this.gate.decide({ remoteJid: message.remoteJid, fromMe: message.fromMe });
    if (!decision.forward) {
      console.error(
        `Stewra Bridge: ${message.remoteJid} is not ticked (${decision.reason}); the message stays on ` +
          'this computer — Stewra never sees it.',
      );
      return;
    }

    // `decision.jid` is the canonical address, which may differ from `message.remoteJid` (a self-chat that
    // arrived as a LID is forwarded under the phone JID). The server keys everything on this one identity.
    console.error(
      `Stewra Bridge: forwarding a message on ${message.remoteJid} as ${decision.jid} ` +
        `(selfChat=${decision.isSelfChat}) to Stewra.`,
    );
    const identity = {
      providerMessageId: message.providerMessageId,
      jid: decision.jid,
      isSelfChat: decision.isSelfChat,
      fromMe: message.fromMe,
      sentAt: message.sentAt.toISOString(),
    };
    if (message.voice === null) {
      this.stewra.inbound({ ...identity, text: message.text });
      return;
    }
    const { data, mime, seconds } = message.voice;
    this.stewra.inbound({
      ...identity,
      audio: { data: data.toString('base64'), mime, ...(seconds !== null ? { seconds } : {}) },
    });
  }

  /** Stewra approved a send. We deliver it and report back honestly, including when we failed. */
  private async handleSend(payload: BridgeSendPayload): Promise<BridgeSendAck> {
    const replyTo = payload.replyTo ?? null;
    console.error(
      `Stewra Bridge: Stewra asked to send a reply to ${payload.jid}` +
        (replyTo === null ? '.' : ` quoting ${replyTo}.`),
    );
    if (this.waState !== 'open') {
      console.error('Stewra Bridge: WhatsApp is not connected; the reply could not be delivered.');
      return { ok: false, error: 'whatsapp_not_connected' };
    }
    try {
      const providerMessageId =
        payload.audio === undefined
          ? await this.whatsapp.sendText(payload.jid, payload.text, replyTo)
          : await this.whatsapp.sendVoiceNote(payload.jid, Buffer.from(payload.audio.data, 'base64'), replyTo);
      console.error(
        `Stewra Bridge: delivered Stewra's ${payload.audio === undefined ? 'reply' : 'voice note'} to ` +
          `${payload.jid} (id ${providerMessageId}).`,
      );
      return { ok: true, providerMessageId };
    } catch (error) {
      console.error('Stewra Bridge: failed to deliver Stewra\'s reply:', error);
      return { ok: false, error: error instanceof Error ? error.message : 'send_failed' };
    }
  }
}
