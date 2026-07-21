import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bake the API URL into a packaged build.
 *
 * A packaged desktop app is launched by double-click, with no `STEWRA_API_URL` in its environment — so the
 * URL the bridge dials cannot come from the runtime env there. It has to be decided at PACKAGE time and
 * carried inside the app. This script runs after `tsc` and before `electron-builder`, and overwrites the
 * compiled `dist/main/bakedConfig.js` with the resolved value.
 *
 * Resolution (fail loud if neither is present — never guess a server for someone's WhatsApp session):
 *   1. `process.env.STEWRA_API_URL` — lets CI point a build at staging without editing anything.
 *   2. the declared `stewra.apiBaseUrl` in bridge/package.json — the stable production default.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const declared = pkg.stewra?.apiBaseUrl;
const apiBaseUrl = process.env.STEWRA_API_URL ?? declared;

if (!apiBaseUrl) {
  console.error(
    'inject-config: no API URL to bake in. Set STEWRA_API_URL, or declare stewra.apiBaseUrl in bridge/package.json.',
  );
  process.exit(1);
}

try {
  // eslint-disable-next-line no-new
  new URL(apiBaseUrl);
} catch {
  console.error(`inject-config: STEWRA_API_URL / stewra.apiBaseUrl is not a valid URL: ${apiBaseUrl}`);
  process.exit(1);
}

const target = join(root, 'dist', 'main', 'bakedConfig.js');
await writeFile(target, `export const BAKED_API_URL = ${JSON.stringify(apiBaseUrl)};\n`);
console.log(`inject-config: baked apiBaseUrl = ${apiBaseUrl} -> dist/main/bakedConfig.js`);
