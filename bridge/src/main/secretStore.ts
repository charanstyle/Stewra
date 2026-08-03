import { safeStorage } from 'electron';
import type { SecretStore } from '../core/authState.js';

/**
 * The real keystore: macOS Keychain, Windows DPAPI, libsecret on Linux. `core/` takes this as an
 * injected dependency, which is what lets the credential-storage logic be tested without Electron.
 *
 * We do NOT fall back to plaintext, or to a key baked into the binary, when the OS keystore is missing.
 * A user on a Linux box with no keyring gets a clear refusal instead of a WhatsApp session written to
 * disk in the clear. Anyone who can read that file can BE them on WhatsApp — that is not a degraded mode
 * worth offering, and offering it silently would be worse than not shipping at all.
 */
export function createSafeStorageSecretStore(): SecretStore {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Stewra Bridge cannot start: this computer has no OS keystore available, so your WhatsApp ' +
        'session could not be encrypted at rest. On Linux this usually means no keyring (gnome-keyring ' +
        'or kwallet) is running. Stewra Bridge will not store your WhatsApp login unencrypted.',
    );
  }

  // ⚠️ THE LINUX TRAP. `isEncryptionAvailable()` returns TRUE on a Linux box with no keyring, because
  // Chromium quietly falls back to a `basic_text` backend that "encrypts" with a HARDCODED key. Every
  // Stewra Bridge in the world would use the same one. That is not encryption; it is base64 with extra
  // steps, and trusting it would mean writing a live WhatsApp session to disk in effectively-plaintext
  // while this app told the user it was safe. Refuse, and say exactly why.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    // Don't state that no keyring is RUNNING — that claim was wrong in the one case we reproduced. On a
    // Debian 13 XFCE box with gnome-keyring installed, running and unlocked, Chromium still landed on
    // `basic_text` purely because it did not recognise the desktop. `selectLinuxKeyStorageBackend()` in
    // main.ts now names the backend, so reaching here means the keyring is genuinely absent or
    // unreachable — but the message should describe both, since the user cannot tell them apart.
    throw new Error(
      'Stewra Bridge cannot start: no usable system keyring was found, so your WhatsApp session cannot ' +
        'be encrypted at rest. (Linux would otherwise fall back to a hardcoded key, which is not real ' +
        'encryption — anyone who could read the file could sign in as you on WhatsApp.) Install and ' +
        'start gnome-keyring or kwallet — and if one is already running, make sure its login keyring is ' +
        'unlocked — then open Stewra Bridge again.',
    );
  }

  return {
    encrypt: (plaintext: string): Buffer => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext: Buffer): string => safeStorage.decryptString(ciphertext),
  };
}
