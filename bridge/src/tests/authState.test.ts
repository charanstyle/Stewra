import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { useEncryptedAuthState } from '../core/authState.js';
import type { SecretStore } from '../core/authState.js';

/**
 * Stands in for Electron's `safeStorage` (macOS Keychain / Windows DPAPI / libsecret). The point of these
 * tests is the STORAGE CONTRACT — nothing readable hits the disk, a session survives a restart, a dead
 * keystore is not salvaged — not the cipher, which belongs to the operating system.
 *
 * base64 is emphatically NOT encryption. It is here for one narrow reason: it makes the transform
 * non-identity, so that "the file does not contain the plaintext" can actually FAIL if someone changes
 * `authState` to write raw JSON and skip the store. A prefix-only fake would leave the plaintext sitting
 * in the file and the assertion could never fire — a test that cannot fail is not a test.
 */
const store: SecretStore = {
  encrypt: (plaintext) => Buffer.from(`enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`, 'utf8'),
  decrypt: (ciphertext) => {
    const text = ciphertext.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not ours');
    return Buffer.from(text.slice('enc:'.length), 'base64').toString('utf8');
  },
};

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stewra-bridge-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the encrypted session store', () => {
  it('starts a fresh session when there is nothing stored', async () => {
    const auth = await useEncryptedAuthState(dir, store);
    expect(auth.state.creds.registered).toBe(false);
  });

  it('never writes the WhatsApp session to disk in plaintext', async () => {
    const auth = await useEncryptedAuthState(dir, store);
    await auth.saveCreds();

    const file = await readFile(join(dir, 'creds.enc'));
    // Anyone who can read this file can BE the user on WhatsApp, so it must be unreadable at rest.
    expect(file.toString('utf8').startsWith('enc:')).toBe(true);
    expect(file.toString('utf8')).not.toContain('"noiseKey"');
  });

  it('survives a restart — quitting the app must not cost the user their session', async () => {
    const first = await useEncryptedAuthState(dir, store);
    first.state.creds.registered = true;
    await first.saveCreds();

    const second = await useEncryptedAuthState(dir, store);

    expect(second.state.creds.registered).toBe(true);
    // The noise key round-trips as a Buffer, not as JSON's idea of one. If it did not, the session would
    // load "successfully" and then fail to connect.
    expect(Buffer.isBuffer(second.state.creds.noiseKey.private)).toBe(true);
  });

  it('treats an unreadable session as no session, rather than salvaging half of one', async () => {
    const auth = await useEncryptedAuthState(dir, store);
    auth.state.creds.registered = true;
    await auth.saveCreds();

    // A keystore that no longer holds the key: a restored backup, a different machine, a reinstall.
    const hostile: SecretStore = {
      encrypt: store.encrypt,
      decrypt: () => {
        throw new Error('this keystore cannot decrypt that');
      },
    };

    const reloaded = await useEncryptedAuthState(dir, hostile);

    // Fresh credentials, and the user re-pairs. A corrupt session would reconnect into `badSession`,
    // which is a path toward a ban rather than toward a working bridge.
    expect(reloaded.state.creds.registered).toBe(false);
  });

  it('rehydrates app-state-sync-key through the protobuf — THE silent-failure trap', async () => {
    // Get this wrong and app-state sync no-ops: no chats, no contacts, no names, and NO ERROR anywhere.
    // The bridge connects, reports itself healthy, and does nothing. There is no log line to find.
    const auth = await useEncryptedAuthState(dir, store);
    const keyData = proto.Message.AppStateSyncKeyData.fromObject({
      keyData: Buffer.from('key-material'),
      fingerprint: { rawId: 1, currentIndex: 1, deviceIndexes: [0] },
      timestamp: 1_700_000_000,
    });

    await auth.state.keys.set({ 'app-state-sync-key': { 'AAAAAA': keyData } });

    const reloaded = await useEncryptedAuthState(dir, store);
    const got = await reloaded.state.keys.get('app-state-sync-key', ['AAAAAA']);

    // A plain object parsed out of JSON would satisfy neither of these — and would still "work".
    expect(got['AAAAAA']).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect(got['AAAAAA']?.fingerprint?.rawId).toBe(1);
  });

  it('deletes a key when Baileys sets it to null', async () => {
    const auth = await useEncryptedAuthState(dir, store);
    await auth.state.keys.set({ 'pre-key': { '1': { public: Buffer.from('p'), private: Buffer.from('s') } } });
    expect(await readdir(dir)).toContain('pre-key-1.enc');

    await auth.state.keys.set({ 'pre-key': { '1': null } });

    expect(await readdir(dir)).not.toContain('pre-key-1.enc');
  });

  it('wipes everything on clear — a revoked device keeps nothing', async () => {
    const auth = await useEncryptedAuthState(dir, store);
    await auth.saveCreds();

    await auth.clear();

    await expect(readdir(dir)).rejects.toThrow();
  });
});
