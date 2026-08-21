import type { BridgeWaState } from '@stewra/shared-types';

/**
 * The contract between the three processes: main (Node, ESM), preload (sandboxed, CommonJS) and renderer
 * (Chromium, ESM).
 *
 * ⚠️ This file is `.cts` — CommonJS — on purpose, and it is the one place in `bridge/` that is. Electron
 * runs preload scripts sandboxed by default, and a sandboxed preload can only be CommonJS. The main
 * process is ESM (Baileys is ESM-only), and ESM can import CommonJS, so a `.cts` module is the only shape
 * that BOTH of them can import. The renderer takes types from here and nothing else — it never touches
 * `ipcRenderer` directly, only the narrow surface `preload` hands it.
 */

export const IPC = {
  /** renderer → main, invoke. The current state, for first paint. */
  GET_STATE: 'stewra:get-state',
  /** renderer → main, invoke. Claim the pairing code, then bring up WhatsApp. */
  PAIR: 'stewra:pair',
  /**
   * renderer → main, invoke. Wipe the local WhatsApp session, this device's Stewra token, its ticks and
   * its chat directory. WhatsApp still lists the link until the user removes it from their phone.
   */
  UNPAIR: 'stewra:unpair',
  SET_AUTOSTART: 'stewra:set-autostart',
  /** renderer → main, invoke. Hide the "we turned this on for you" banner. Does not change the setting. */
  DISMISS_AUTOSTART_NOTICE: 'stewra:dismiss-autostart-notice',
  /** main → renderer, send. Pushed on every state change; the UI never polls. */
  STATE_CHANGED: 'stewra:state-changed',
  /** renderer → main, invoke. The pickable chats + current ticks, for the picker. */
  GET_CHATS: 'stewra:get-chats',
  /** renderer → main, invoke. Replace the ticked set with these JIDs. Applies immediately. */
  SET_TICKED_CHATS: 'stewra:set-ticked-chats',
  /** main → renderer, send. The chat directory changed; a fresh ChatPickerState rides along. */
  CHATS_CHANGED: 'stewra:chats-changed',
} as const;

/** One row in the picker. Names came from WhatsApp — the renderer must treat them as text, never markup. */
export interface ChatSummary {
  readonly jid: string;
  readonly displayName: string;
  /** Last seen activity, epoch ms. 0 = known only from the cache/contacts, no activity observed. */
  readonly lastActivity: number;
  readonly ticked: boolean;
}

/**
 * Everything the picker renders. The list NEVER includes the self-chat — that row is pinned "always
 * on" in the UI and cannot be unticked, because a bridge that ignores the self-chat is just broken.
 */
export interface ChatPickerState {
  readonly chats: readonly ChatSummary[];
}

/** Everything the window and the tray render from. One object, pushed on change. */
export interface BridgeUiState {
  /** Whether this device holds a Stewra token. Independent of whether WhatsApp is up. */
  readonly paired: boolean;
  readonly waState: BridgeWaState;
  /**
   * Whether the live socket to Stewra is up. Tracked separately from `waState` because WhatsApp open
   * with Stewra unreachable means forwarded messages are being dropped, and the UI must say so.
   */
  readonly stewraConnected: boolean;
  /** The human reason behind a terminal state — a ban, a logout. Shown verbatim, never softened. */
  readonly detail: string | null;
  /** A QR code (PNG `data:` URL) to scan from WhatsApp → Linked Devices. Null unless we are pairing. */
  readonly qrDataUrl: string | null;
  readonly autostart: boolean;
  /**
   * Whether "start at login" can actually be turned ON. False in a development run.
   *
   * macOS's login-item API registers whichever app bundle is CURRENTLY RUNNING and gives no way to point
   * somewhere else — `path`/`args` are Windows-only. In `npm start` the running bundle is Electron's own
   * (`electron/dist/Electron.app`), so ticking the box would schedule macOS to launch bare Electron at
   * every login: it comes up on Electron's default welcome window, with no bridge behind it.
   *
   * Turning it OFF stays allowed even when this is false — clearing a bad registration is the repair.
   */
  readonly autostartAvailable: boolean;
  /**
   * True only in the moment after pairing turned autostart on by itself, so the window can say so. The
   * user is told what changed on their machine and given one click to undo it — enrolling someone
   * silently would be the kind of thing people uninstall an app over.
   */
  readonly autostartJustEnabled: boolean;
  readonly appVersion: string;
  /** Shown in the UI so the user can see which server this bridge talks to. It is never guessed. */
  readonly apiBaseUrl: string;
}

export interface PairRequest {
  /**
   * The code minted by the Stewra web app. Null when this device is ALREADY paired to Stewra and is only
   * re-linking WhatsApp — after a logout, say. Making the user fetch a fresh code in that case would be
   * asking them to fix something that is not broken.
   */
  readonly stewraCode: string | null;
}

export interface PairResult {
  readonly ok: boolean;
  /** The failure, in words worth showing to a person. Null on success. */
  readonly error: string | null;
}

/** The entire surface the renderer gets. Deliberately small: no `ipcRenderer`, no `require`, no Node. */
export interface StewraBridgeApi {
  getState(): Promise<BridgeUiState>;
  pair(request: PairRequest): Promise<PairResult>;
  unpair(): Promise<void>;
  setAutostart(enabled: boolean): Promise<void>;
  dismissAutostartNotice(): Promise<void>;
  onStateChanged(listener: (state: BridgeUiState) => void): void;
  getChats(): Promise<ChatPickerState>;
  /**
   * JIDs only, on purpose: the main process resolves display names from ITS OWN directory rather than
   * trusting strings from the window that renders WhatsApp content, and those resolved names are what
   * sync to the server as the allowlist.
   */
  setTickedChats(jids: readonly string[]): Promise<ChatPickerState>;
  onChatsChanged(listener: (state: ChatPickerState) => void): void;
}
