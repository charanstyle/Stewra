// What was on screen when a test failed.
//
// A device test that fails with "testID X never became visible" is nearly unactionable on its own:
// the phone has already moved on by the time anyone looks, and the interesting state — an OS sheet
// covering the app, a permission dialog, a half-rendered screen — is gone. So capture it at the
// moment of failure, into `artifacts/`, named for the device and test.
//
// Capture failures are reported, never swallowed: if the screenshot itself cannot be taken that is
// usually the finding (the session died), and hiding it behind an empty catch would erase the one
// clue worth having.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver } from './session.ts';
import type { Device } from './devices.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ARTIFACT_DIR = resolve(HERE, '../artifacts');

function slug(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Write a screenshot and the full element hierarchy for `device`.
 *
 * `stamp` disambiguates repeat captures within one run; it is passed in rather than read from the
 * clock so a caller can key artifacts to the test that produced them.
 */
export async function capture(
  driver: Driver,
  device: Device,
  stamp: string,
): Promise<string[]> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const base = join(ARTIFACT_DIR, `${slug(device.udid)}-${slug(stamp)}`);
  const written: string[] = [];

  const png = await driver.takeScreenshot();
  writeFileSync(`${base}.png`, Buffer.from(png, 'base64'));
  written.push(`${base}.png`);

  const source = await driver.getPageSource();
  writeFileSync(`${base}.xml`, source, 'utf8');
  written.push(`${base}.xml`);

  return written;
}

/**
 * Capture for a failing test, and say where it went.
 *
 * Wired up through Vitest's `onTestFailed`, so it runs only on the failure path and cannot mask a
 * pass. If the capture cannot happen the reason is printed — the test has already failed, so this
 * adds information rather than changing the verdict.
 */
export async function captureFailure(
  driver: Driver,
  device: Device,
  testName: string,
): Promise<void> {
  try {
    const files = await capture(driver, device, testName);
    console.error(`[artifacts] ${device.label} failed — wrote:\n  ${files.join('\n  ')}`);
  } catch (error) {
    console.error(
      `[artifacts] ${device.label} failed, and the screen could not be captured either — ` +
        'the session is probably dead, which is itself the finding.\n  ' +
        String(error),
    );
  }
}
