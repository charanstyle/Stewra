import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeImage, shell } from 'electron';
import type { BridgeAllowedChat, BridgeWaState } from '@stewra/shared-types';
import { normalizeJid } from '../core/allowlist.js';
import { Bridge } from '../core/bridge.js';
import { claimBridgeToken } from '../core/stewraClient.js';
import { loadBridgeConfig } from '../core/config.js';
import type { BridgeConfig } from '../core/config.js';
import { AllowedChatsStore, ChatDirectoryCache } from './allowedChatsStore.js';
import { Autostart, AutostartDecision, linuxExecPath, startedAtLogin } from './autostart.js';
import { BAKED_API_URL } from './bakedConfig.js';
import { linuxKeyStorageBackend } from './keyStorageBackend.js';
import { createSafeStorageSecretStore } from './secretStore.js';
import { TokenStore } from './tokenStore.js';
import { quitAndInstall, startUpdater } from './updater.js';
import type { SecretStore } from '../core/authState.js';
import { IPC } from './ipc.cjs';
import type { BridgeUiState, ChatPickerState, PairRequest, PairResult } from './ipc.cjs';

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

/** Genuinely relaying means BOTH sides are up — WhatsApp open AND the Stewra socket connected. A
 * forwarded message with Stewra down is dropped, so a live icon then would be a lie. */
const isLive = (state: BridgeWaState, stewraConnected: boolean): boolean => state === 'open' && stewraConnected;

let tray: Tray | null = null;
let window: BrowserWindow | null = null;
let bridge: Bridge | null = null;
let tokenStore: TokenStore | null = null;
let allowedChatsStore: AllowedChatsStore | null = null;
let directoryCache: ChatDirectoryCache | null = null;
let autostart: Autostart | null = null;
let autostartDecision: AutostartDecision | null = null;
/** The chats the user ticked, as synced to the gate and the server. Loaded from disk at boot. */
let tickedChats: readonly BridgeAllowedChat[] = [];
/** Set only by the tray's Quit item. Closing the window HIDES it — a bridge that quit is a bridge that
 * stopped answering, and the user would not find out until they wondered why Stewra had gone silent. */
let quitting = false;

/** What the updater has to offer, reflected as tray items. See updater.ts for the mode semantics. */
let updateNotice:
  | { kind: 'none' }
  | { kind: 'available'; version: string; downloadUrl: string }
  | { kind: 'downloaded'; version: string } = { kind: 'none' };

let uiState: BridgeUiState = {
  paired: false,
  waState: 'disconnected',
  stewraConnected: false,
  detail: null,
  qrDataUrl: null,
  autostart: false,
  autostartAvailable: false,
  autostartJustEnabled: false,
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
  return uiState.stewraConnected ? labels[uiState.waState] : `${labels[uiState.waState]} · Stewra unreachable`;
}

function refreshTray(): void {
  if (tray === null) return;
  tray.setImage(trayIcon(isLive(uiState.waState, uiState.stewraConnected)));
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayTooltip(), enabled: false },
      { type: 'separator' },
      // deb installs: electron-updater cannot replace a dpkg-managed app, so this only points at the
      // download page. macOS/AppImage: the update is already staged; restarting applies it.
      ...(updateNotice.kind === 'available'
        ? [
            {
              label: `Update available (${updateNotice.version}) — download`,
              click: (): void => {
                if (updateNotice.kind === 'available') void shell.openExternal(updateNotice.downloadUrl);
              },
            },
            { type: 'separator' as const },
          ]
        : []),
      ...(updateNotice.kind === 'downloaded'
        ? [
            {
              label: `Restart to update (${updateNotice.version})`,
              click: (): void => {
                quitting = true;
                quitAndInstall();
              },
            },
            { type: 'separator' as const },
          ]
        : []),
      { label: 'Open Stewra Bridge', click: () => showWindow() },
      {
        // A tray-only user never sees the window's explanation, so the label carries it: without this the
        // checkbox would simply refuse to stay ticked, with nothing on screen saying why.
        label: uiState.autostartAvailable ? 'Start at login' : 'Start at login (packaged app only)',
        type: 'checkbox',
        checked: uiState.autostart,
        click: (item) => void setAutostart(item.checked),
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

/**
 * Register — or clear — "start at login", and reflect what the OS says is true afterwards.
 *
 * Every refusal and platform quirk lives in `autostart.ts`; this is only the wiring plus how a failure
 * reaches the user. A failure is never silent: the bridge not coming back after a reboot is precisely the
 * complaint this feature exists to answer, so the reason is put on screen and on stderr.
 */
async function setAutostart(enabled: boolean): Promise<void> {
  if (autostart === null) {
    console.error('Stewra Bridge: start-at-login was toggled before the app finished starting; ignored.');
    return;
  }
  try {
    const registered = await autostart.write(enabled);
    publish({ autostart: registered, autostartJustEnabled: false });
    if (enabled && !registered) {
      publish({
        detail:
          'macOS has not approved Stewra Bridge as a login item. Allow it in System Settings → General → ' +
          'Login Items, or the bridge will not come back after a restart.',
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Stewra Bridge: could not change start-at-login: ${reason}`);
    // The attempt failed, so the setting is whatever it was BEFORE it: off if we were enabling, still on
    // if we were disabling. Echoing the attempted value would tell the user the exact opposite of the truth.
    publish({ autostart: !enabled, autostartJustEnabled: false, detail: reason });
  }
}

/**
 * Turn autostart on by itself, once, when a computer first pairs.
 *
 * A bridge that is not running is a Stewra that has silently stopped relaying WhatsApp — the user finds
 * out from a reply that never came. Leaving that behind an unticked box in a footer put the burden on
 * people who had no way to know it mattered, so pairing now opts them in and SAYS SO, with one click to
 * undo it.
 *
 * Exactly once, though. The decision is remembered before the write, so somebody who deliberately turns
 * it off is never quietly re-enrolled by a later re-pair.
 */
async function enableAutostartOnFirstPair(): Promise<void> {
  if (autostart === null || autostartDecision === null || !autostart.available) return;
  if (await autostartDecision.decided()) return;
  await autostartDecision.remember(new Date().toISOString());
  if (await autostart.read()) return;

  try {
    const registered = await autostart.write(true);
    publish({ autostart: registered, autostartJustEnabled: registered });
  } catch (error) {
    // Pairing SUCCEEDED. Failing it over a convenience setting would throw away the thing the user
    // actually came to do — but the failure is still reported, never swallowed.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Stewra Bridge: could not turn on start-at-login after pairing: ${reason}`);
    publish({ detail: `Stewra Bridge could not turn on "start at login": ${reason}` });
  }
}

/** `~/.config/autostart`, honouring `XDG_CONFIG_HOME` where the session sets it. */
function xdgAutostartDir(): string {
  const configHome = process.env['XDG_CONFIG_HOME'];
  return configHome !== undefined && configHome.trim().length > 0
    ? join(configHome.trim(), 'autostart')
    : join(homedir(), '.config', 'autostart');
}

/** The picker's view: every known chat, most recent first, with its tick. Composed fresh per ask. */
function pickerState(): ChatPickerState {
  const ticked = new Set(tickedChats.map((c) => c.jid));
  return {
    chats: (bridge?.getChats() ?? []).map((chat) => ({
      jid: chat.jid,
      displayName: chat.displayName,
      lastActivity: chat.lastActivity,
      ticked: ticked.has(chat.jid),
    })),
  };
}

function pushChatPickerState(): void {
  window?.webContents.send(IPC.CHATS_CHANGED, pickerState());
}

/** Build a Bridge and wire its events to the UI. One instance per WhatsApp session; replaced on re-link. */
function createBridge(activeConfig: BridgeConfig, secrets: SecretStore): Bridge {
  const instance: Bridge = new Bridge({
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
        // The ticks and the directory belong to the account that was just cut off; a future pairing may
        // be a different account, and inheriting another account's allowlist would be wrong twice over.
        tickedChats = [];
        void allowedChatsStore?.clear();
        void directoryCache?.clear();
        publish({ paired: false, waState: 'disconnected', stewraConnected: false, qrDataUrl: null, detail: null });
        pushChatPickerState();
      },
      onStewraConnection: (connected) => {
        if (instance !== bridge) return;
        publish({ stewraConnected: connected });
      },
      onChatsChanged: () => {
        // A re-link replaces the Bridge; a replaced instance's late events must not keep driving the
        // picker or the cache.
        if (instance !== bridge) return;
        pushChatPickerState();
        void directoryCache?.write(instance.serializeChatDirectory());
      },
    },
  });
  return instance;
}

async function startBridge(
  activeConfig: BridgeConfig,
  secrets: SecretStore,
  token: string,
): Promise<void> {
  bridge?.stop();
  bridge = createBridge(activeConfig, secrets);
  // Rehydrate before connecting: the picker should not be empty just because the app restarted, and
  // the ticks must be in the gate before the first message can possibly arrive.
  const cachedDirectory = await directoryCache?.read();
  if (cachedDirectory !== null && cachedDirectory !== undefined) bridge.hydrateChatDirectory(cachedDirectory);
  bridge.setTickedChats(tickedChats);
  await bridge.start(token);
}

function registerIpc(activeConfig: BridgeConfig, secrets: SecretStore, store: TokenStore): void {
  ipcMain.handle(IPC.GET_STATE, (): BridgeUiState => uiState);

  ipcMain.handle(IPC.SET_AUTOSTART, (_event, enabled: boolean): Promise<void> => setAutostart(enabled));

  // Dismiss only — the setting itself is untouched. The banner has served its purpose once it has been read.
  ipcMain.handle(IPC.DISMISS_AUTOSTART_NOTICE, (): void => publish({ autostartJustEnabled: false }));

  ipcMain.handle(IPC.PAIR, async (_event, request: PairRequest): Promise<PairResult> => {
    try {
      let token = await store.read();

      // A fresh pairing: trade the web app's one-time code for this device's own long-lived token.
      if (request.stewraCode !== null) {
        token = await claimBridgeToken(activeConfig, request.stewraCode, deviceName());
        await store.write(token);
        publish({ paired: true });
      }

      if (token === null) {
        return { ok: false, error: 'This device is not paired with Stewra yet. Enter a pairing code.' };
      }

      await startBridge(activeConfig, secrets, token);
      // After the bridge is up, not before: opting someone into "start at login" is only meaningful once
      // the thing that will start actually works.
      await enableAutostartOnFirstPair();
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
    // Unlinking ends this account's relationship with this machine; its chat list and ticks go too.
    tickedChats = [];
    await allowedChatsStore?.clear();
    await directoryCache?.clear();
    publish({ paired: false, waState: 'disconnected', stewraConnected: false, qrDataUrl: null, detail: null });
    pushChatPickerState();
  });

  ipcMain.handle(IPC.GET_CHATS, (): ChatPickerState => pickerState());

  ipcMain.handle(IPC.SET_TICKED_CHATS, async (_event, raw: unknown): Promise<ChatPickerState> => {
    // The renderer sends bare JIDs and nothing else. Display names are resolved HERE, from the main
    // process's own directory — the window that renders WhatsApp content does not get to write the
    // strings that sync to the server — and a JID the directory has never seen is simply dropped.
    const requested = Array.isArray(raw) ? raw.filter((j): j is string => typeof j === 'string') : [];
    const known = new Map((bridge?.getChats() ?? []).map((chat) => [chat.jid, chat]));
    const picked: BridgeAllowedChat[] = [];
    for (const jid of requested) {
      const chat = known.get(normalizeJid(jid));
      if (chat !== undefined) {
        picked.push({ jid: chat.jid, displayName: chat.displayName, isSelfChat: false });
      }
    }
    tickedChats = picked;
    await allowedChatsStore?.write(picked);
    bridge?.setTickedChats(picked);
    return pickerState();
  });
}

/** What the user will see in Stewra's device list. The hostname is the only useful thing we have. */
function deviceName(): string {
  return `Stewra Bridge on ${process.env['HOSTNAME'] ?? process.env['COMPUTERNAME'] ?? 'this computer'}`;
}

// Ask for a real keyring on Linux desktops Chromium does not recognise, BEFORE `app.whenReady()` —
// command-line switches are read during Chromium startup. See keyStorageBackend.ts for why.
const keyStorageBackend = linuxKeyStorageBackend(process.platform, process.argv, process.env);
if (keyStorageBackend !== null) {
  app.commandLine.appendSwitch('password-store', keyStorageBackend);
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

    autostart = new Autostart({
      platform: process.platform,
      packaged: app.isPackaged,
      autostartDir: xdgAutostartDir(),
      execPath: linuxExecPath(process.env, process.execPath),
      loginItem: {
        read: (): boolean => app.getLoginItemSettings().openAtLogin,
        write: (enabled: boolean): void => app.setLoginItemSettings({ openAtLogin: enabled }),
      },
    });
    autostartDecision = new AutostartDecision(app.getPath('userData'));

    tokenStore = new TokenStore(app.getPath('userData'), secrets);
    allowedChatsStore = new AllowedChatsStore(app.getPath('userData'), secrets);
    directoryCache = new ChatDirectoryCache(app.getPath('userData'), secrets);
    const token = await tokenStore.read();
    tickedChats = (await allowedChatsStore.read()) ?? [];

    uiState = {
      ...uiState,
      paired: token !== null,
      // The real registration, not what we last set: a stale entry left by an earlier run must be VISIBLE
      // in the checkbox, because unticking it is how the user clears it.
      autostart: await autostart.read(),
      autostartAvailable: autostart.available,
      appVersion: activeConfig.appVersion,
      apiBaseUrl: activeConfig.apiBaseUrl,
    };

    registerIpc(activeConfig, secrets, tokenStore);

    // The download page lives on the same origin as the API (the baked production URL, or the
    // STEWRA_API_URL override) — derived, never guessed, so a staging build points at staging.
    const downloadUrl = `${activeConfig.apiBaseUrl}/runner`;
    startUpdater({
      onUpdateAvailable: (version) => {
        updateNotice = { kind: 'available', version, downloadUrl };
        refreshTray();
      },
      onUpdateDownloaded: (version) => {
        updateNotice = { kind: 'downloaded', version };
        refreshTray();
      },
    });

    tray = new Tray(trayIcon(false));
    refreshTray();
    tray.on('click', () => showWindow());

    // Launched at login: come up in the tray and start relaying, without stealing focus. Showing a window
    // every time someone logs in is how a helper app gets uninstalled.
    // `wasOpenedAtLogin` is macOS-only; the Linux entry passes `--hidden` so this holds on both.
    if (!startedAtLogin(process.argv, app.getLoginItemSettings().wasOpenedAtLogin)) showWindow();

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
