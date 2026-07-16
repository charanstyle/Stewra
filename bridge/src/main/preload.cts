import { contextBridge, ipcRenderer } from 'electron';
import type { IPC as IPC_CONTRACT } from './ipc.cjs';
import type { BridgeUiState, PairRequest, PairResult, StewraBridgeApi } from './ipc.cjs';

/**
 * ⚠️ A sandboxed preload cannot `require` sibling files — only Electron's polyfilled builtins. A value
 * import of `IPC` from `./ipc.cjs` compiles, then dies at runtime with "module not found", taking
 * `window.stewra` with it. So the channel names are written out again here, pinned to the contract by
 * `typeof IPC_CONTRACT` (a type-only import, erased at compile time): rename a channel in ipc.cts and
 * this object stops compiling.
 */
const IPC: typeof IPC_CONTRACT = {
  GET_STATE: 'stewra:get-state',
  PAIR: 'stewra:pair',
  UNPAIR: 'stewra:unpair',
  SET_AUTOSTART: 'stewra:set-autostart',
  STATE_CHANGED: 'stewra:state-changed',
};

/**
 * The only bridge between the renderer and Node — and it is a keyhole, not a door.
 *
 * The renderer is sandboxed, context-isolated and has no Node integration. It cannot read the WhatsApp
 * session, cannot reach the filesystem, cannot open a socket. It can call the five functions below and
 * nothing else. That matters because the renderer is the one part of this app that renders remote-ish
 * content (names and text that came from WhatsApp), and it is therefore the part most worth containing.
 *
 * Note what is NOT exposed: `ipcRenderer` itself. Handing that over would let any script in the window
 * invoke arbitrary IPC channels, which quietly undoes the isolation it appears to preserve.
 */
const api: StewraBridgeApi = {
  getState: (): Promise<BridgeUiState> => ipcRenderer.invoke(IPC.GET_STATE),
  pair: (request: PairRequest): Promise<PairResult> => ipcRenderer.invoke(IPC.PAIR, request),
  unpair: (): Promise<void> => ipcRenderer.invoke(IPC.UNPAIR),
  setAutostart: (enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC.SET_AUTOSTART, enabled),
  onStateChanged: (listener: (state: BridgeUiState) => void): void => {
    // The event object is dropped deliberately: it carries a `sender` handle that has no business
    // crossing into page context.
    ipcRenderer.on(IPC.STATE_CHANGED, (_event, state: BridgeUiState) => listener(state));
  },
};

contextBridge.exposeInMainWorld('stewra', api);
