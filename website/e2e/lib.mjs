// Shared helpers for the website E2E suite: token refresh, API access, conversation lookup,
// and Playwright context setup that seeds an authenticated session + grants call permissions.
//
// Auth on the website lives in localStorage["stewra.tokens"], which is per-origin and shared
// across tabs — so two users cannot coexist in one browser context. Every test therefore runs
// each user in their OWN context, seeded via addInitScript before the first navigation.
import { chromium } from 'playwright';
import { config } from './config.mjs';

export const WEB = config.webUrl;
export const API = config.apiUrl;
export const A = config.users.a;
export const B = config.users.b;
export const TOKENS_KEY = 'stewra.tokens';

/** Decode a JWT payload (no verification — just to read `sub`). */
export function jwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

/** Exchange a refresh token for a fresh access token, mutating the user in place. */
export async function refresh(user) {
  const res = await fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: user.refreshToken }),
  });
  const json = await res.json().catch(() => null);
  if (json?.data?.tokens) {
    user.accessToken = json.data.tokens.accessToken;
    user.refreshToken = json.data.tokens.refreshToken;
    return true;
  }
  return false;
}

/** Refresh both users up front — the website does NOT auto-refresh, so seed fresh tokens per run. */
export async function refreshAll() {
  const [a, b] = await Promise.all([refresh(A), refresh(B)]);
  if (!a || !b) {
    throw new Error('[e2e] Token refresh failed — check that the refresh tokens in config are still valid.');
  }
}

/** Thin authenticated JSON fetch against the backend. Defaults to user A. */
export async function apiCall(path, { method = 'GET', token = A.accessToken, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json };
}

/** Resolve the direct (1:1) conversation between A and B. Requires them to be contacts. */
export async function directConvId() {
  const { json } = await apiCall('/conversations');
  const bId = jwt(B.accessToken).sub;
  const found = json?.data?.conversations?.find(
    (c) => c.conversation.type === 'direct' && c.participants.some((p) => p.id === bId),
  );
  if (!found) {
    throw new Error('[e2e] No direct conversation between A and B — make the two test users contacts first.');
  }
  return found.conversation.id;
}

/** Chromium flags that make WebRTC + voice work headless without real hardware. */
export function launchArgs() {
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  if (config.audioFile) {
    args.push(`--use-file-for-fake-audio-capture=${config.audioFile}`);
  }
  return args;
}

export function launchBrowser() {
  return chromium.launch({ headless: true, args: launchArgs() });
}

/** A fresh browser context authenticated as `user`, with mic+camera granted for calls. */
export async function contextFor(browser, user) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  await ctx.grantPermissions(['microphone', 'camera'], { origin: WEB });
  await ctx.addInitScript(
    ([key, value]) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* storage unavailable — page will redirect to login and the test will fail loudly */
      }
    },
    [TOKENS_KEY, JSON.stringify({ accessToken: user.accessToken, refreshToken: user.refreshToken })],
  );
  return ctx;
}

// ---- Minimal reporter ------------------------------------------------------

/** Wrap a single feature check so one failure never aborts the whole suite. */
export async function step(report, name, fn) {
  try {
    const detail = await fn();
    report.push({ name, status: 'PASS', detail: detail || '' });
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    const msg = String(err?.message || err).split('\n')[0].slice(0, 160);
    report.push({ name, status: 'FAIL', detail: msg });
    console.log(`  ❌ ${name} — ${msg}`);
    return false;
  }
}

export function summarize(report) {
  const pass = report.filter((r) => r.status === 'PASS').length;
  const fail = report.filter((r) => r.status === 'FAIL').length;
  console.log(`\n=== ${pass} passed, ${fail} failed of ${report.length} checks ===`);
  return { pass, fail, total: report.length };
}
