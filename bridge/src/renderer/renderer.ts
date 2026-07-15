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
    readonly stewra: StewraBridgeApi;
  }
}

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

const dot = el('dot');
const statusLabel = el('status-label');
const statusDetail = el('status-detail');
const pairPanel = el('pair-panel');
const codeField = el('code-field');
const codePanel = el('code-panel');
const linkedPanel = el('linked-panel');
const pairingCode = el('pairing-code');
const errorText = el('error');
const stewraCodeInput = inputEl('stewra-code');
const phoneInput = inputEl('phone');
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
  const showingCode = state.pairingCode !== null;

  // Already paired to Stewra but WhatsApp needs re-linking: ask for the phone number, not for a fresh
  // pairing code. The token is still perfectly valid, and making them re-fetch one implies otherwise.
  codeField.hidden = state.paired;

  pairPanel.hidden = linked || showingCode;
  codePanel.hidden = !showingCode;
  linkedPanel.hidden = !linked;

  pairingCode.textContent = state.pairingCode ?? '';
  autostartInput.checked = state.autostart;
  versionText.textContent = `v${state.appVersion}`;
  apiText.textContent = state.apiBaseUrl;
}

function showError(message: string | null): void {
  errorText.textContent = message ?? '';
  errorText.hidden = message === null;
}

pairButton.addEventListener('click', () => {
  const phoneNumber = phoneInput.value.trim();
  if (phoneNumber === '') {
    showError('Enter the phone number of the WhatsApp account you want to link.');
    return;
  }

  const typedCode = stewraCodeInput.value.trim();
  if (!codeField.hidden && typedCode === '') {
    showError('Enter the pairing code shown in the Stewra web app.');
    return;
  }

  showError(null);
  pairButton.disabled = true;
  pairButton.textContent = 'Linking…';

  void window.stewra
    .pair({ stewraCode: codeField.hidden ? null : typedCode, phoneNumber })
    .then((result) => {
      if (!result.ok) showError(result.error);
    })
    .finally(() => {
      pairButton.disabled = false;
      pairButton.textContent = 'Link WhatsApp';
    });
});

unpairButton.addEventListener('click', () => {
  void window.stewra.unpair();
});

autostartInput.addEventListener('change', () => {
  void window.stewra.setAutostart(autostartInput.checked);
});

window.stewra.onStateChanged(render);
void window.stewra.getState().then(render);
