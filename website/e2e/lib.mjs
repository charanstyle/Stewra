// Shared helpers for the website E2E suite: API password login, REST access, contact/conversation
// setup, and Playwright context/storageState seeding of an authenticated session (+ call permissions).
//
// Auth on the website lives in localStorage["stewra.tokens"], which is per-origin and shared
// across tabs — so two users cannot coexist in one browser context. Every test therefore runs
// each user in their OWN context, seeded before the first navigation.
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

/** Log in via the API and return fresh tokens. No pasted tokens: a run needs only email+password. */
export async function loginViaApi(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => null);
  const tokens = json?.data?.tokens;
  if (!tokens?.accessToken || !tokens?.refreshToken) {
    throw new Error(
      `[e2e] Login failed for ${email} (HTTP ${res.status}). Check the QA credentials in .env.e2e.`,
    );
  }
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

/** Log in a config user, mutating it in place with fresh tokens. */
export async function login(user) {
  const tokens = await loginViaApi(user.email, user.password);
  user.accessToken = tokens.accessToken;
  user.refreshToken = tokens.refreshToken;
  return tokens;
}

/**
 * Log both users in up front — the website does NOT auto-refresh, so mint fresh tokens per run.
 * Each run gets brand-new short-lived tokens, so there is no stale-token failure mode.
 */
export async function loginAll() {
  await Promise.all([login(A), login(B)]);
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

/** The user's own id, read from their access-token JWT `sub`. */
export function uid(user) {
  return jwt(user.accessToken).sub;
}

/** REST call as `user` that throws on any non-2xx / `{success:false}` and returns `.data`. */
export async function api(user, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${user.accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { success: false, error: { message: text.slice(0, 200) } };
  }
  if (!res.ok || json.success === false) {
    throw new Error(`${method} ${path} → ${json?.error?.message ?? `HTTP ${res.status}`}`);
  }
  return json.data;
}

/** Find A↔otherId direct conversation id, or null. */
export async function findDirect(user, otherId) {
  const { conversations } = await api(user, 'GET', '/conversations');
  return (
    conversations.find(
      (c) => c.conversation.type === 'direct' && c.participants.some((p) => p.id === otherId),
    )?.conversation.id ?? null
  );
}

/** Make A and B mutual contacts (idempotent — accepts any pending invite B has from A). */
export async function ensureContacts(a, b) {
  try {
    await api(a, 'POST', '/contacts/invites', { inviteeEmail: b.email });
  } catch {
    /* already invited / already contacts */
  }
  try {
    const inv = await api(b, 'GET', '/contacts/invites');
    for (const entry of inv.received ?? []) {
      const id = entry.invite?.id ?? entry.id;
      const status = entry.invite?.status ?? entry.status;
      if (id && (status === undefined || status === 'pending')) {
        await api(b, 'POST', `/contacts/invites/${id}/respond`, { action: 'accept' }).catch(() => {});
      }
    }
  } catch {
    /* no invites endpoint data — fall through */
  }
}

/** Resolve (creating if needed) the direct conversation between A and B. Requires them to be contacts. */
export async function ensureConversation(a, b) {
  let id = await findDirect(a, uid(b));
  if (id) {
    return id;
  }
  await ensureContacts(a, b);
  const { conversation } = await api(a, 'POST', '/conversations', {
    type: 'direct',
    participantUserIds: [uid(b)],
  });
  return conversation.id;
}

/** Resolve the direct (1:1) conversation between the configured A and B. Requires them to be contacts. */
export async function directConvId() {
  const id = await findDirect(A, uid(B));
  if (!id) {
    throw new Error('[e2e] No direct conversation between A and B — make the two test users contacts first.');
  }
  return id;
}

/** A Playwright storageState that authenticates `user` on the site (localStorage token seed). */
export function storageStateFor(user) {
  return {
    cookies: [],
    origins: [
      {
        origin: WEB,
        localStorage: [
          {
            name: TOKENS_KEY,
            value: JSON.stringify({ accessToken: user.accessToken, refreshToken: user.refreshToken }),
          },
        ],
      },
    ],
  };
}

/**
 * True once the site under test carries the E2E `data-testid` contract. The `app-nav`
 * sentinel is rendered on every authenticated page, so its absence means the running
 * build predates the testids (e.g. the suite is pointed at prod but the change hasn't
 * been deployed yet). Specs use this to `test.skip(...)` with a clear "deploy first"
 * message instead of failing with an opaque selector timeout. `page` must already be on
 * an authenticated route.
 */
export async function uiHasTestids(page) {
  return (await page.getByTestId('app-nav').count()) > 0;
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
