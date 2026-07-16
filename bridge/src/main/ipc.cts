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
  /** renderer → main, invoke. Wipe the WhatsApp session and this device's Stewra token. */
  UNPAIR: 'stewra:unpair',
  SET_AUTOSTART: 'stewra:set-autostart',
  /** main → renderer, send. Pushed on every state change; the UI never polls. */
  STATE_CHANGED: 'stewra:state-changed',
} as const;

/** Everything the window and the tray render from. One object, pushed on change. */
export interface BridgeUiState {
  /** Whether this device holds a Stewra token. Independent of whether WhatsApp is up. */
  readonly paired: boolean;
  readonly waState: BridgeWaState;
  /** The human reason behind a terminal state — a ban, a logout. Shown verbatim, never softened. */
  readonly detail: string | null;
  /** A QR code (PNG `data:` URL) to scan from WhatsApp → Linked Devices. Null unless we are pairing. */
  readonly qrDataUrl: string | null;
  readonly autostart: boolean;
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
  onStateChanged(listener: (state: BridgeUiState) => void): void;
}
