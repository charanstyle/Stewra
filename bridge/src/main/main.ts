import { join } from 'node:path';
import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeImage, shell } from 'electron';
import type { BridgeWaState } from '@stewra/shared-types';
import { Bridge } from '../core/bridge.js';
import { loadBridgeConfig } from '../core/config.js';
import type { BridgeConfig } from '../core/config.js';
import { BAKED_API_URL } from './bakedConfig.js';
import { createSafeStorageSecretStore } from './secretStore.js';
import { TokenStore } from './tokenStore.js';
import type { SecretStore } from '../core/authState.js';
import { IPC } from './ipc.cjs';
import type { BridgeUiState, PairRequest, PairResult } from './ipc.cjs';

/**
 * Stewra Bridge — the Electron shell.
 *
 * The shell owns three things and no more: where the session lives on disk, the window and tray the user
 * sees, and the app's lifecycle. Every decision that could damage a WhatsApp account — the reconnect
 * table, the allowlist gate, `end()` vs `logout()` — lives in `core/`, which knows nothing about Electron
 * and is therefore tested without it.
 *
 * ⚠️ This process is ESM (see tsconfig). `__dirname` and `require` do not exist here; `import.meta.dirname`
 * does. The preload is CommonJS (`.cjs`) because Electron's sandboxed preloads must be.
 */

/** WhatsApp states in which the bridge is genuinely relaying. Everything else is a degraded tray icon. */
const isLive = (state: BridgeWaState): boolean => state === 'open';

let tray: Tray | null = null;
let window: BrowserWindow | null = null;
let bridge: Bridge | null = null;
let tokenStore: TokenStore | null = null;
/** Set only by the tray's Quit item. Closing the window HIDES it — a bridge that quit is a bridge that
 * stopped answering, and the user would not find out until they wondered why Stewra had gone silent. */
let quitting = false;

let uiState: BridgeUiState = {
  paired: false,
  waState: 'disconnected',
  detail: null,
  qrDataUrl: null,
  autostart: false,
  appVersion: '0.0.0',
  apiBaseUrl: '',
};

function publish(patch: Partial<BridgeUiState>): void {
  uiState = { ...uiState, ...patch };
  window?.webContents.send(IPC.STATE_CHANGED, uiState);
  refreshTray();
}

// ─── tray ────────────────────────────────────────────────────────────────────────────────────────────

function trayIcon(live: boolean): Electron.NativeImage {
  const file = live ? 'tray-live.png' : 'tray-idle.png';
  const image = nativeImage.createFromPath(join(import.meta.dirname, '../assets', file));
  // macOS renders template images in the menu-bar's own colour, light or dark. Without this the icon is
  // a black square on a dark menu bar.
  image.setTemplateImage(true);
  return image;
}

function trayTooltip(): string {
  if (!uiState.paired) return 'Stewra Bridge — not paired';
  const labels: Record<BridgeWaState, string> = {
    open: 'Stewra Bridge — connected to WhatsApp',
    connecting: 'Stewra Bridge — connecting…',
    pairing: 'Stewra Bridge — waiting to be linked',
    disconnected: 'Stewra Bridge — not connected',
    logged_out: 'Stewra Bridge — logged out of WhatsApp',
    banned: 'Stewra Bridge — this WhatsApp account was banned',
  };
  return labels[uiState.waState];
}

function refreshTray(): void {
  if (tray === null) return;
  tray.setImage(trayIcon(isLive(uiState.waState)));
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayTooltip(), enabled: false },
      { type: 'separator' },
      { label: 'Open Stewra Bridge', click: () => showWindow() },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: uiState.autostart,
        click: (item) => setAutostart(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

// ─── window ──────────────────────────────────────────────────────────────────────────────────────────

function showWindow(): void {
  if (window !== null) {
    window.show();
    window.focus();
    return;
  }

  window = new BrowserWindow({
    width: 480,
    height: 680,
    resizable: false,
    title: 'Stewra Bridge',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      // The renderer displays text that came from WhatsApp. It gets no Node, no filesystem, no sockets —
      // only the five functions in preload.cts.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));

  // Closing the window must not stop the bridge — see `quitting`.
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  window.on('closed', () => {
    window = null;
  });

  // Any link in the UI (the Stewra web app, the WhatsApp help page) opens in the real browser, never in
  // an Electron window that would look like a browser without being one.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── lifecycle ───────────────────────────────────────────────────────────────────────────────────────

function setAutostart(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
  publish({ autostart: enabled });
}

/** Build a Bridge and wire its events to the UI. One instance per WhatsApp session; replaced on re-link. */
function createBridge(activeConfig: BridgeConfig, secrets: SecretStore): Bridge {
  return new Bridge({
    config: activeConfig,
    authDir: join(app.getPath('userData'), 'whatsapp'),
    secretStore: secrets,
    events: {
      onState: (waState, message) => {
        publish({
          waState,
          detail: message ?? null,
          // A QR is only meaningful while pairing; leaving a stale one on screen invites the user to scan
          // an expired code and conclude that we are broken.
          qrDataUrl: waState === 'pairing' ? uiState.qrDataUrl : null,
        });
      },
      onQr: (qrDataUrl) => publish({ qrDataUrl }),
      onSessionDestroyed: () => {
        // WhatsApp ended it, not Stewra. The device token is still good — the user only needs to re-link.
        publish({ qrDataUrl: null });
      },
      onRevoked: () => {
        void tokenStore?.clear();
        publish({ paired: false, waState: 'disconnected', qrDataUrl: null, detail: null });
      },
    },
  });
}

async function startBridge(
  activeConfig: BridgeConfig,
  secrets: SecretStore,
  token: string,
): Promise<void> {
  bridge?.stop();
  bridge = createBridge(activeConfig, secrets);
  await bridge.start(token);
}

function registerIpc(activeConfig: BridgeConfig, secrets: SecretStore, store: TokenStore): void {
  ipcMain.handle(IPC.GET_STATE, (): BridgeUiState => uiState);

  ipcMain.handle(IPC.SET_AUTOSTART, (_event, enabled: boolean): void => setAutostart(enabled));

  ipcMain.handle(IPC.PAIR, async (_event, request: PairRequest): Promise<PairResult> => {
    try {
      let token = await store.read();

      // A fresh pairing: trade the web app's one-time code for this device's own long-lived token.
      if (request.stewraCode !== null) {
        const pending = createBridge(activeConfig, secrets);
        token = await pending.pairWithStewra(request.stewraCode, deviceName());
        await store.write(token);
        publish({ paired: true });
      }

      if (token === null) {
        return { ok: false, error: 'This device is not paired with Stewra yet. Enter a pairing code.' };
      }

      await startBridge(activeConfig, secrets, token);
      return { ok: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Stewra Bridge could not pair.';
      publish({ waState: 'disconnected', detail: message, qrDataUrl: null });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(IPC.UNPAIR, async (): Promise<void> => {
    // Local half of a revoke. The user should ALSO remove "Stewra Bridge" from WhatsApp → Linked Devices
    // on their phone; the UI says so, because this app cannot do it for them.
    bridge?.stop();
    bridge = null;
    await store.clear();
    publish({ paired: false, waState: 'disconnected', qrDataUrl: null, detail: null });
  });
}

/** What the user will see in Stewra's device list. The hostname is the only useful thing we have. */
function deviceName(): string {
  return `Stewra Bridge on ${process.env['HOSTNAME'] ?? process.env['COMPUTERNAME'] ?? 'this computer'}`;
}

// A second copy would fight the first for the same WhatsApp session — `connectionReplaced`, on loop. That
// is precisely the reconnect storm that gets accounts flagged.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  void app.whenReady().then(async () => {
    let activeConfig: BridgeConfig;
    let secrets: SecretStore;

    try {
      // Both of these fail loud, at boot, in front of a human — and for the same reason. A bridge that
      // guessed at a server URL would point a WhatsApp session somewhere the user never agreed to; a
      // bridge with no real keystore would write that session to disk where anyone could read it. Neither
      // is a degraded mode worth running in, so neither gets a silent fallback.
      // A GUI launch carries no STEWRA_API_URL; fall back to the value baked in at package time.
      activeConfig = loadBridgeConfig(
        { STEWRA_API_URL: process.env['STEWRA_API_URL'] ?? BAKED_API_URL },
        app.getVersion(),
      );
      secrets = createSafeStorageSecretStore();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Stewra Bridge is misconfigured.';
      // Both, not either. The dialog is for the person double-clicking an icon; the stderr line is for
      // the person who launched it from a terminal, and for whoever reads their support ticket later. A
      // refusal that exists only inside a modal is a refusal nobody can paste to you.
      console.error(`Stewra Bridge cannot start: ${message}`);
      dialog.showErrorBox('Stewra Bridge cannot start', message);
      app.quit();
      return;
    }

    tokenStore = new TokenStore(app.getPath('userData'), secrets);
    const token = await tokenStore.read();

    uiState = {
      ...uiState,
      paired: token !== null,
      autostart: app.getLoginItemSettings().openAtLogin,
      appVersion: activeConfig.appVersion,
      apiBaseUrl: activeConfig.apiBaseUrl,
    };

    registerIpc(activeConfig, secrets, tokenStore);

    tray = new Tray(trayIcon(false));
    refreshTray();
    tray.on('click', () => showWindow());

    // Launched at login: come up in the tray and start relaying, without stealing focus. Showing a window
    // every time someone logs in is how a helper app gets uninstalled.
    const startedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;
    if (!startedAtLogin) showWindow();

    // An existing session resumes with no phone number and no pairing code — WhatsApp is not asked for
    // anything it does not need.
    if (token !== null) {
      await startBridge(activeConfig, secrets, token).catch((error: unknown) => {
        publish({
          waState: 'disconnected',
          detail: error instanceof Error ? error.message : 'Stewra Bridge could not reach WhatsApp.',
        });
      });
    }
  });

  // A tray app outlives its window on every platform, macOS included.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', () => {
    quitting = true;
    // ⚠️ `Bridge.stop()` calls `sock.end()`, never `sock.logout()`. Quitting must not unlink the device
    // from the user's WhatsApp account.
    bridge?.stop();
  });
}
