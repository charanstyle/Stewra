import type { BridgeAllowedChat, BridgeSendAck, BridgeSendPayload, BridgeWaState } from '@stewra/shared-types';
import { AllowlistGate } from './allowlist.js';
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
}

export interface BridgeOptions {
  readonly config: BridgeConfig;
  readonly authDir: string;
  readonly secretStore: SecretStore;
  readonly events: BridgeEvents;
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
  /** The chats the user ticked in this app. Empty in v1: the self-chat is enough to prove the loop. */
  private tickedChats: BridgeAllowedChat[] = [];

  constructor(private readonly options: BridgeOptions) {
    this.whatsapp = new WhatsappClient({
      authDir: options.authDir,
      secretStore: options.secretStore,
      appVersion: options.config.appVersion,
      events: {
        onState: (state, message) => this.handleWaState(state, message),
        onMessage: (message) => this.handleMessage(message),
        onQr: (qrDataUrl) => options.events.onQr(qrDataUrl),
        onSessionDestroyed: () => options.events.onSessionDestroyed(),
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
      onConnected: () => this.stewra.hello(this.waState),
      onDisconnected: () => undefined,
    });
  }

  /** Exchange the pairing code from the web app for a device token. Throws with a message to show. */
  async pairWithStewra(code: string, deviceName: string): Promise<string> {
    return this.stewra.claimToken(code, deviceName);
  }

  /** Start: connect to Stewra with the saved token, then bring up WhatsApp. */
  async start(token: string): Promise<void> {
    this.stewra.connect(token);
    await this.whatsapp.connect();
  }

  stop(): void {
    this.whatsapp.stop();
    this.stewra.disconnect();
  }

  /** The user ticked or unticked chats. Takes effect immediately, on this machine and on the server. */
  setTickedChats(chats: readonly BridgeAllowedChat[]): void {
    this.tickedChats = [...chats];
    this.gate?.setAllowed(this.tickedChats);
    this.syncAllowedChats();
  }

  private handleWaState(state: BridgeWaState, message?: string): void {
    this.waState = state;

    if (state === 'open') {
      const ownJid = this.whatsapp.ownJid;
      if (ownJid !== null) {
        const ownLid = this.whatsapp.ownLid;
        // The LID matters because WhatsApp addresses the self-chat by it on some clients; logging both here
        // is what let us diagnose a self-message being dropped as "not_allowed" when it arrived as a LID.
        console.error(
          `Stewra Bridge: WhatsApp open as ${ownJid}${ownLid !== null ? ` (lid ${ownLid})` : ''}.`,
        );
        this.gate = new AllowlistGate(ownJid, ownLid ?? undefined);
        this.gate.setAllowed(this.tickedChats);
        this.syncAllowedChats();
      }
    }

    // Tell the server, so the web app's status dot is the truth rather than a guess.
    this.stewra.state(state);
    this.options.events.onState(state, message);
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
   */
  private handleMessage(message: WhatsappMessage): void {
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
    this.stewra.inbound({
      providerMessageId: message.providerMessageId,
      jid: decision.jid,
      isSelfChat: decision.isSelfChat,
      fromMe: message.fromMe,
      text: message.text,
      sentAt: message.sentAt.toISOString(),
    });
  }

  /** Stewra approved a send. We deliver it and report back honestly, including when we failed. */
  private async handleSend(payload: BridgeSendPayload): Promise<BridgeSendAck> {
    console.error(`Stewra Bridge: Stewra asked to send a reply to ${payload.jid}.`);
    if (this.waState !== 'open') {
      console.error('Stewra Bridge: WhatsApp is not connected; the reply could not be delivered.');
      return { ok: false, error: 'whatsapp_not_connected' };
    }
    try {
      const providerMessageId = await this.whatsapp.sendText(payload.jid, payload.text);
      console.error(`Stewra Bridge: delivered Stewra's reply to ${payload.jid} (id ${providerMessageId}).`);
      return { ok: true, providerMessageId };
    } catch (error) {
      console.error('Stewra Bridge: failed to deliver Stewra\'s reply:', error);
      return { ok: false, error: error instanceof Error ? error.message : 'send_failed' };
    }
  }
}
