import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc.cjs';
import type { BridgeUiState, PairRequest, PairResult, StewraBridgeApi } from './ipc.cjs';

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
