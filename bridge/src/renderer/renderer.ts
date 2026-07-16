import type { BridgeUiState, StewraBridgeApi } from '../main/ipc.cjs';

/**
 * The window. It has no Node, no filesystem and no network of its own (see the CSP in index.html) — it
 * renders `BridgeUiState` and calls the five functions `preload.cts` exposed. Everything it displays
 * arrives over IPC.
 *
 * The `ipc.cjs` import above is types only, and is erased at compile time. A value import would not
 * survive here: this file runs in Chromium as an ES module and cannot `require` a CommonJS one.
 */
declare global {
  interface Window {
    /** `undefined` when the preload script failed to load — a mis-built app, not a state to limp through. */
    readonly stewra: StewraBridgeApi | undefined;
  }
}

/**
 * If the preload died, every button in this window is a lie — clicking "Link WhatsApp" would show
 * "Linking…" forever while doing nothing at all (which is exactly what happened before this guard
 * existed). Refuse to render the UI and say why, in the window and on stderr.
 */
function requireStewraApi(): StewraBridgeApi {
  if (window.stewra === undefined) {
    const message =
      'Stewra Bridge is broken: its preload script failed to load, so this window cannot talk to the ' +
      'app. Rebuild or reinstall Stewra Bridge.';
    document.body.textContent = message;
    throw new Error(message);
  }
  return window.stewra;
}

const stewra = requireStewraApi();

/** Look-ups that fail loudly at startup rather than silently no-op'ing later against a null. */
function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Stewra Bridge: the window is missing #${id}`);
  return node;
}

function inputEl(id: string): HTMLInputElement {
  const node = el(id);
  if (!(node instanceof HTMLInputElement)) throw new Error(`Stewra Bridge: #${id} is not an input`);
  return node;
}

function buttonEl(id: string): HTMLButtonElement {
  const node = el(id);
  if (!(node instanceof HTMLButtonElement)) throw new Error(`Stewra Bridge: #${id} is not a button`);
  return node;
}

function imgEl(id: string): HTMLImageElement {
  const node = el(id);
  if (!(node instanceof HTMLImageElement)) throw new Error(`Stewra Bridge: #${id} is not an image`);
  return node;
}

const dot = el('dot');
const statusLabel = el('status-label');
const statusDetail = el('status-detail');
const pairPanel = el('pair-panel');
const codeField = el('code-field');
const qrPanel = el('qr-panel');
const linkedPanel = el('linked-panel');
const pairingQr = imgEl('pairing-qr');
const errorText = el('error');
const stewraCodeInput = inputEl('stewra-code');
const pairButton = buttonEl('pair');
const unpairButton = buttonEl('unpair');
const autostartInput = inputEl('autostart');
const versionText = el('version');
const apiText = el('api');

/**
 * What the user is told, per state. `banned` and `logged_out` are deliberately not softened into
 * "disconnected" — a ban is the exact thing we warned them about, and hiding it behind a neutral word
 * would make the warning dishonest after the fact.
 */
const LABELS: Record<BridgeUiState['waState'], string> = {
  open: 'Connected to WhatsApp',
  connecting: 'Connecting to WhatsApp…',
  pairing: 'Waiting for you to link WhatsApp',
  disconnected: 'Not connected',
  logged_out: 'Logged out of WhatsApp',
  banned: 'This WhatsApp account was banned',
};

const DOT_CLASS: Record<BridgeUiState['waState'], string> = {
  open: 'live',
  connecting: 'busy',
  pairing: 'busy',
  disconnected: '',
  logged_out: 'bad',
  banned: 'bad',
};

function render(state: BridgeUiState): void {
  dot.className = `dot ${DOT_CLASS[state.waState]}`.trim();
  statusLabel.textContent = state.paired ? LABELS[state.waState] : 'Not paired with Stewra';
  statusDetail.textContent = state.detail ?? '';

  const linked = state.paired && state.waState === 'open';
  const showingQr = state.qrDataUrl !== null;

  // Already paired to Stewra but WhatsApp needs re-linking: don't ask for a fresh Stewra code. The token
  // is still perfectly valid, and making them re-fetch one implies otherwise.
  codeField.hidden = state.paired;

  pairPanel.hidden = linked || showingQr;
  qrPanel.hidden = !showingQr;
  linkedPanel.hidden = !linked;

  // Only touch the src when there is a QR; assigning '' would fire a broken-image request under the CSP.
  if (state.qrDataUrl !== null) pairingQr.src = state.qrDataUrl;
  autostartInput.checked = state.autostart;
  versionText.textContent = `v${state.appVersion}`;
  apiText.textContent = state.apiBaseUrl;
}

function showError(message: string | null): void {
  errorText.textContent = message ?? '';
  errorText.hidden = message === null;
}

pairButton.addEventListener('click', () => {
  const typedCode = stewraCodeInput.value.trim();
  if (!codeField.hidden && typedCode === '') {
    showError('Enter the pairing code shown in the Stewra web app.');
    return;
  }

  showError(null);
  pairButton.disabled = true;
  pairButton.textContent = 'Linking…';

  void stewra
    .pair({ stewraCode: codeField.hidden ? null : typedCode })
    .then((result) => {
      if (!result.ok) showError(result.error);
    })
    .finally(() => {
      pairButton.disabled = false;
      pairButton.textContent = 'Link WhatsApp';
    });
});

unpairButton.addEventListener('click', () => {
  void stewra.unpair();
});

autostartInput.addEventListener('change', () => {
  void stewra.setAutostart(autostartInput.checked);
});

stewra.onStateChanged(render);
void stewra.getState().then(render);
