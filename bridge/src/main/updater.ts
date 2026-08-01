import { app } from 'electron';
// electron-updater ships CommonJS; under this ESM main process the named export is not statically
// analyzable, so import the default and destructure (the pattern electron-updater documents for ESM).
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

/**
 * Auto-update for the Stewra Bridge tray app, fed by the GitHub release feed electron-builder bakes
 * into the packaged app (app-update.yml → latest-mac.yml / latest-linux.yml on `releases/latest`).
 *
 * Three modes, decided by how this copy is installed:
 *
 *   'auto'   macOS (zip target) and Linux AppImage — electron-updater can replace these safely, so
 *            updates download in the background and install when the user quits, or immediately via
 *            the tray's "Restart to update".
 *   'notify' Linux deb — electron-updater cannot update a dpkg-managed install, so the feed is only
 *            CHECKED; the tray shows "Update available — download" linking the download page.
 *   'off'    unpackaged dev runs (`npm start`) — there is no installed app to update, and the checks
 *            would 404 against a feed for builds that don't exist.
 *
 * Every failure is logged loudly and none may crash the process: THIS APP HOLDS A LIVE WHATSAPP
 * SESSION, and an update check is never worth taking that down. That is also why nothing here calls
 * `quitAndInstall` on its own — restarting is always the user's click, or the natural next quit
 * (`autoInstallOnAppQuit`).
 */

export type UpdaterMode = 'auto' | 'notify' | 'off';

export interface UpdaterEvents {
  /** notify mode: a newer build exists; the tray links the download page. */
  onUpdateAvailable(version: string): void;
  /** auto mode: the update is downloaded and staged; the tray offers "Restart to update". */
  onUpdateDownloaded(version: string): void;
}

/** First check ~30s after boot — after the WhatsApp session has settled, before the first tray look. */
const FIRST_CHECK_DELAY_MS = 30_000;
/** A tray app runs for weeks; a 6h cadence keeps a fleet current within a day of a release. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function updaterMode(): UpdaterMode {
  if (!app.isPackaged) return 'off';
  if (process.platform === 'darwin') return 'auto';
  if (process.platform === 'linux') {
    // electron-builder sets APPIMAGE on the process it launches from an AppImage mount. Absent that,
    // this is a deb (or a bare unpacked dir) — installs electron-updater must not touch.
    return process.env['APPIMAGE'] !== undefined ? 'auto' : 'notify';
  }
  return 'off';
}

export function startUpdater(events: UpdaterEvents): UpdaterMode {
  const mode = updaterMode();
  if (mode === 'off') return mode;

  autoUpdater.autoDownload = mode === 'auto';
  autoUpdater.autoInstallOnAppQuit = mode === 'auto';

  autoUpdater.on('error', (error) => {
    // Loud but non-fatal: an unreachable feed or a bad download must never take the bridge down.
    console.error(`Stewra Bridge updater: ${error.message}`);
  });
  autoUpdater.on('update-available', (info) => {
    console.error(`Stewra Bridge updater: version ${info.version} is available (mode: ${mode}).`);
    if (mode === 'notify') events.onUpdateAvailable(info.version);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.error(`Stewra Bridge updater: version ${info.version} downloaded; will install on quit.`);
    events.onUpdateDownloaded(info.version);
  });

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.error(
        `Stewra Bridge updater: check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
  return mode;
}

/** The tray's "Restart to update". Only meaningful in auto mode after `onUpdateDownloaded`. */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
