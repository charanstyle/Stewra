import { describe, expect, it } from 'vitest';
import { SECOND_PROFILE_MESSAGE, userDataOverride } from '../main/singleProfile.js';

/**
 * THE PROMISE: "one machine runs one Stewra Bridge, linked to one Stewra account."
 *
 * It did not. `app.requestSingleInstanceLock()` is keyed on the userData directory, so passing
 * `--user-data-dir` gave a second copy its own lock, its own Stewra device token and its own WhatsApp
 * session — two bridges on one computer, each believing it was the only one. That is not a thought
 * experiment; it is how a second bridge was actually started on this Mac.
 *
 * The argument shapes below are Chromium's, not ours: it accepts `--flag=value`, `--flag value`, and the
 * same two with a single dash. Miss any one of them and the bypass is still open, which is why each is a
 * case here rather than a comment.
 */

describe('userDataOverride', () => {
  it('finds the flag in every shape Chromium accepts', () => {
    expect(userDataOverride(['electron', '--user-data-dir=/tmp/other'])).toBe('/tmp/other');
    expect(userDataOverride(['electron', '--user-data-dir', '/tmp/other'])).toBe('/tmp/other');
    expect(userDataOverride(['electron', '-user-data-dir=/tmp/other'])).toBe('/tmp/other');
    expect(userDataOverride(['electron', '-user-data-dir', '/tmp/other'])).toBe('/tmp/other');
  });

  it('reports the flag with no value as an override attempt, not as absence', () => {
    // `''` is a directory nobody asked for, but it is still someone reaching for the switch. Returning
    // null here would let `--user-data-dir` as the final argument through.
    expect(userDataOverride(['electron', '--user-data-dir'])).toBe('');
  });

  it('passes the ordinary launches through', () => {
    expect(userDataOverride(['electron', 'dist/main/main.js'])).toBeNull();
    expect(userDataOverride(['/Applications/Stewra Bridge.app/Contents/MacOS/Stewra Bridge'])).toBeNull();
    expect(userDataOverride(['electron', '--hidden'])).toBeNull();
    expect(userDataOverride(['electron', '--remote-debugging-port=9333'])).toBeNull();
  });

  it('does not match a flag that merely starts the same way', () => {
    // `--user-data-dir-suffix` is a real Chromium switch and does NOT relocate the profile.
    expect(userDataOverride(['electron', '--user-data-dir-suffix=x'])).toBeNull();
    expect(userDataOverride(['electron', '--no-user-data-dir'])).toBeNull();
  });

  it('reads a path that itself looks like a flag', () => {
    expect(userDataOverride(['electron', '--user-data-dir', '--hidden'])).toBe('--hidden');
  });

  it('says what was refused and what to do instead', () => {
    // The message is the whole user experience of this refusal — it is shown in a modal to someone who
    // may never see a terminal. It must name the flag and offer the way forward.
    expect(SECOND_PROFILE_MESSAGE).toContain('--user-data-dir');
    expect(SECOND_PROFILE_MESSAGE).toContain('one Stewra account');
    expect(SECOND_PROFILE_MESSAGE).toContain('unlink');
  });
});
