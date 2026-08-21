import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import type { HostIdentity } from '@stewra/shared-types';

const run = promisify(execFile);

/**
 * Read the platform's own identifier for this computer.
 *
 * ⚠️ THIS FILE IS DUPLICATED, DELIBERATELY, at `runner/src/core/hostIdentity.ts`. The two must read the
 * same thing on the same machine or a bridge and a runner sitting on one box look like two. They are
 * duplicated rather than shared because one ships inside an Electron asar and the other inside a
 * single-file Node binary, on separate release cadences — and because the thing that must not drift is not
 * this code, it is the ANSWER. That is why the answer is labelled: each identity carries the `kind` it was
 * read from, the server matches on `kind` AND value, and a future divergence in how one side reads the
 * machine shows up as two different kinds that plainly do not match, rather than two hashes that silently
 * never do. If you change this file, change the other, and change the shared doc in
 * `packages/shared-types/src/realtime/hostIdentity.ts`.
 *
 * ONE source per platform, no second-choice location, and no derived substitute. `null` means "this
 * platform is not one we read an id for" — a known state, reported as absence. Anything else THROWS: on a
 * platform we do support, a machine that cannot say who it is has something badly wrong with it, and the
 * caller treats that the way this app treats every other missing prerequisite — loudly, at boot, in front
 * of a human. Guessing from a hostname or a MAC address would pair unrelated computers, and the whole
 * point of this identifier is that it is the one thing that does not.
 */
export async function readHostIdentity(platform: NodeJS.Platform): Promise<HostIdentity | null> {
  if (platform === 'darwin') {
    // `ioreg` is part of macOS itself. IOPlatformUUID survives OS reinstalls and disk erases; it is the
    // identifier Apple's own tooling uses to mean "this Mac".
    const { stdout } = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const found = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout);
    if (found?.[1] === undefined) {
      throw new Error('ioreg did not report an IOPlatformUUID for this Mac.');
    }
    return { kind: 'darwin-platform-uuid', value: found[1].trim().toLowerCase(), hostname: hostname() };
  }

  if (platform === 'linux') {
    // `/etc/machine-id` is the systemd/D-Bus machine id: stable for the life of the installation, and
    // present on every distribution either app is built for.
    const value = (await readFile('/etc/machine-id', 'utf8')).trim().toLowerCase();
    if (value === '') throw new Error('/etc/machine-id is empty; this machine has no stable identifier.');
    return { kind: 'linux-machine-id', value, hostname: hostname() };
  }

  return null;
}
