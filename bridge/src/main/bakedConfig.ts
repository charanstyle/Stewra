/**
 * The API URL baked in at PACKAGE time — the fallback used when the app is double-clicked (a GUI launch
 * has no `STEWRA_API_URL` in its environment). See `scripts/inject-config.mjs`, which overwrites the
 * compiled `dist/main/bakedConfig.js` with the resolved value during `npm run package:*`.
 *
 * It is `undefined` here on purpose: in development (`npm start`, `electron dist/main/main.js`) nothing
 * bakes it, so the bridge still requires a real `STEWRA_API_URL` in the shell and fails loud without one.
 * Only a packaged build carries a concrete value, and that value comes from the packaging environment
 * (or the declared `stewra.apiBaseUrl` in package.json) — never a literal in this source file.
 */
export const BAKED_API_URL: string | undefined = undefined;
