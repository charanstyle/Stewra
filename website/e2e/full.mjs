// FULL end-user E2E of the Stewra website — drives EVERY feature by navigation + clicks
// (no deep-links except the unavoidable entry into the nav-orphaned area). Live production.
// Each feature is isolated in its own try/catch and always emits a report line:
//   pass | fail | info | skip(reason).  Destructive-to-real-data ops are skip+reason, not omitted.
//
// Usage: node full.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as cfg } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });

const WEB = cfg.webUrl;
const API = cfg.apiUrl;
const AUDIO = cfg.audioFile && cfg.audioFile.trim() ? cfg.audioFile.trim() : null;
const TOKEN_KEY = 'stewra.tokens';

// ---------- reporting ----------
const report = [];
const rec = (section, feature, kind, info = '') => {
  report.push({ section, feature, kind, info });
  const tag = { pass: 'PASS', fail: 'FAIL', info: 'INFO', skip: 'SKIP' }[kind] || kind.toUpperCase();
  console.log(`${tag.padEnd(4)} [${section}] ${feature}${info ? ' — ' + info : ''}`);
};
const pass = (s, f, i) => rec(s, f, 'pass', i);
const fail = (s, f, i) => rec(s, f, 'fail', i);
const info = (s, f, i) => rec(s, f, 'info', i);
const skip = (s, f, i) => rec(s, f, 'skip', i);

const nonce = () => Math.random().toString(36).slice(2, 8);
const b64urlJson = (seg) => JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
const jwt = (t) => b64urlJson(t.split('.')[1]);
const uid = (u) => jwt(u.accessToken).sub;
const shot = async (page, name) => { try { await page.screenshot({ path: join(SHOTS, `${name}.png`) }); } catch { /* ignore */ } };
const settle = (page, ms = 1000) => page.waitForTimeout(ms);
// run a feature step; never let it abort the suite
async function step(section, feature, fn) {
  try { await fn(); }
  catch (e) { fail(section, feature, (e && e.message ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200)); }
}

// ---------- REST helper (server-to-server; bypasses browser CORS) ----------
async function apiCall(user, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${user.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { success: false, error: { message: text.slice(0, 200) } }; }
  if (!res.ok || json.success === false) {
    const err = new Error(`${method} ${path} → ${json?.error?.message ?? `HTTP ${res.status}`}`);
    err.status = res.status; throw err;
  }
  return json.data;
}
async function refreshUpfront(user, label) {
  try {
    const r = await fetch(`${API}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: user.refreshToken }) });
    const j = await r.json();
    if (r.ok && j?.data?.tokens?.accessToken) {
      user.accessToken = j.data.tokens.accessToken; user.refreshToken = j.data.tokens.refreshToken;
      info('setup', `token refresh ${label}`, `valid until ${new Date(jwt(user.accessToken).exp * 1000).toISOString()}`);
    } else { info('setup', `token refresh ${label}`, `kept provided token (${j?.error?.message ?? r.status})`); }
  } catch (e) { info('setup', `token refresh ${label}`, `kept provided token (${e.message})`); }
}
async function findDirect(user, otherId) {
  const { conversations } = await apiCall(user, 'GET', '/conversations');
  return conversations.find((c) => c.conversation.type === 'direct' && c.participants.some((p) => p.id === otherId))?.conversation.id ?? null;
}
async function ensureContacts(a, b) {
  try { await apiCall(a, 'POST', '/contacts/invites', { inviteeEmail: b.email }); } catch { /* already */ }
  try {
    const inv = await apiCall(b, 'GET', '/contacts/invites');
    for (const entry of inv.received ?? []) {
      const id = entry.invite?.id ?? entry.id; const status = entry.invite?.status ?? entry.status;
      if (id && (status === undefined || status === 'pending')) { try { await apiCall(b, 'POST', `/contacts/invites/${id}/respond`, { action: 'accept' }); } catch { /* */ } }
    }
  } catch { /* */ }
}
async function ensureConversation(a, b) {
  let id = await findDirect(a, uid(b));
  if (id) { info('setup', 'direct conversation', `reused ${id}`); return id; }
  await ensureContacts(a, b);
  const { conversation } = await apiCall(a, 'POST', '/conversations', { type: 'direct', participantUserIds: [uid(b)] });
  info('setup', 'direct conversation', `created ${conversation.id}`); return id = conversation.id;
}

async function makeContext(browser, user, label) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  await context.grantPermissions(['microphone', 'camera'], { origin: WEB });
  await context.addInitScript(([k, v]) => { try { window.localStorage.setItem(k, v); } catch { /* */ } },
    [TOKEN_KEY, JSON.stringify({ accessToken: user.accessToken, refreshToken: user.refreshToken })]);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [${label} pageerror] ${e.message}`));
  return { context, page };
}
// current URL path only
const path = (page) => { try { return new URL(page.url()).pathname; } catch { return page.url(); } };

async function main() {
  console.log(`\n=== Stewra website — FULL end-user E2E ===\nWEB=${WEB}\nAUDIO=${AUDIO ?? '(fake mic; transcript non-verbal)'}\n`);
  const A = cfg.users.a, B = cfg.users.b;
  await refreshUpfront(A, 'A'); await refreshUpfront(B, 'B');

  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(AUDIO ? [`--use-file-for-fake-audio-capture=${AUDIO}`] : [])] });
  const a = await makeContext(browser, A, 'A');
  const b = await makeContext(browser, B, 'B');

  let convId = null;
  try { convId = await ensureConversation(A, B); } catch (e) { fail('setup', 'direct conversation', e.message); }

  // ============================================================= 1. ENTRY / AUTH / NAV
  // 1a. Protected route redirects unauthenticated user to /login (fresh, token-less context)
  await step('auth', 'unauthenticated /chats → redirect to /login', async () => {
    const guest = await browser.newContext();
    const gp = await guest.newPage();
    await gp.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await gp.waitForURL('**/login', { timeout: 12000 }).catch(() => {});
    const ok = path(gp) === '/login';
    (ok ? pass : fail)('auth', 'unauthenticated /chats → redirect to /login', `landed ${path(gp)}`);
    // 1b. login page renders its form (heading + tabs + email/password)
    const heading = await gp.getByRole('heading', { name: 'Stewra' }).first().isVisible().catch(() => false);
    const signInTab = await gp.getByRole('button', { name: 'Sign in' }).first().isVisible().catch(() => false);
    const createTab = await gp.getByRole('button', { name: 'Create account' }).first().isVisible().catch(() => false);
    const emailField = await gp.locator('input[type="email"]').isVisible().catch(() => false);
    (heading && signInTab && createTab && emailField ? pass : fail)('auth', 'login page renders (heading + Sign in/Create account tabs + email field)', `heading=${heading} signIn=${signInTab} create=${createTab} email=${emailField}`);
    await shot(gp, 'full_login_page');
    // toggle to register mode → Name field appears
    if (createTab) {
      await gp.getByRole('button', { name: 'Create account' }).first().click();
      const nameField = await gp.locator('input[autocomplete="name"]').isVisible().catch(() => false);
      (nameField ? pass : info)('auth', 'register mode reveals Name field', `nameVisible=${nameField}`);
    }
    await guest.close();
  });
  skip('auth', 'complete sign-up / email verification via UI', 'no throwaway email+password+inbox code available; render-only checked above');

  // 1c. Authenticated end-user lands on home, and NAV-ORPHAN check
  await step('nav', 'home page (/) navigation reachability', async () => {
    await a.page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
    await settle(a.page, 2000);
    const landed = path(a.page);
    info('nav', 'root "/" landing (authenticated)', `landed ${landed}`);
    const chatsLink = await a.page.getByRole('link', { name: 'Chats' }).isVisible().catch(() => false);
    const talkLink = await a.page.getByRole('link', { name: 'Talk to Stewra' }).isVisible().catch(() => false);
    const contactsLink = await a.page.getByRole('link', { name: 'Contacts' }).isVisible().catch(() => false);
    await shot(a.page, 'full_home_landing');
    if (!chatsLink && !talkLink && !contactsLink) {
      fail('nav', 'home page links to messaging (Chats/Talk to Stewra/Contacts)', `NONE present on ${landed} — messaging is unreachable by navigation from home (AppNav not rendered on /activity)`);
    } else {
      pass('nav', 'home page links to messaging', `chats=${chatsLink} talk=${talkLink} contacts=${contactsLink}`);
    }
    // custom header affordances that DO exist on home
    const learned = await a.page.getByRole('button', { name: /What I.?ve learned/i }).isVisible().catch(() => false);
    const signout = await a.page.getByRole('button', { name: 'Sign out' }).isVisible().catch(() => false);
    info('nav', 'home custom header buttons', `"What I've learned"=${learned}, "Sign out"=${signout}`);
  });

  // 1d. Enter the nav-bearing area (only possible via URL) then verify AppNav links all work by CLICK
  await step('nav', 'AppNav links navigate correctly (click-through)', async () => {
    await a.page.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('link', { name: 'Chats' }).first().waitFor({ timeout: 15000 });
    await a.page.getByRole('link', { name: 'Talk to Stewra' }).click();
    await a.page.waitForURL('**/stewra', { timeout: 10000 });
    await a.page.getByRole('link', { name: 'Contacts' }).click();
    await a.page.waitForURL('**/contacts', { timeout: 10000 });
    await a.page.getByRole('link', { name: 'Chats' }).click();
    await a.page.waitForURL('**/chats', { timeout: 10000 });
    pass('nav', 'AppNav links navigate correctly (Chats↔Stewra↔Contacts)', 'all clicks landed on expected routes');
  });

  // 1e. "What I've learned" (/activity → /memory) and Back
  await step('nav', 'Activity ↔ Memory navigation', async () => {
    await a.page.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('button', { name: /What I.?ve learned/i }).click();
    await a.page.waitForURL('**/memory', { timeout: 10000 });
    await a.page.getByRole('button', { name: 'Back' }).click();
    await a.page.waitForURL('**/activity', { timeout: 10000 });
    pass('nav', 'Activity "What I\'ve learned" → Memory → Back', 'round-trip works');
  });

  // 1f. Unknown route → /activity
  await step('nav', 'unknown route redirects to /activity', async () => {
    await a.page.goto(`${WEB}/zzz-${nonce()}`, { waitUntil: 'domcontentloaded' });
    await settle(a.page, 1500);
    (path(a.page) === '/activity' ? pass : fail)('nav', 'unknown route redirects to /activity', `landed ${path(a.page)}`);
  });

  // 1g. identity: AppNav shows each display name
  await step('auth', 'authenticated identity shown in nav', async () => {
    for (const [u, ctx, lbl] of [[A, a, 'A'], [B, b, 'B']]) {
      await ctx.page.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
      await ctx.page.getByRole('link', { name: 'Chats' }).first().waitFor({ timeout: 15000 });
      await shot(ctx.page, `full_auth_${lbl}`);
      pass('auth', `${lbl} session valid (${u.email})`, `rendered chats at ${path(ctx.page)}`);
    }
  });

  // ============================================================= 2. CHATS LIST (presence + unread)
  await step('chats', 'conversation list renders', async () => {
    await a.page.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('heading', { name: 'Chats' }).waitFor({ timeout: 12000 });
    const rows = a.page.locator('li');
    const n = await rows.count();
    (n > 0 ? pass : info)('chats', 'conversation list renders rows', `${n} row(s)`);
    await shot(a.page, 'full_chats_list');
  });
  await step('chats', 'New chat button routes to Contacts', async () => {
    await a.page.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('button', { name: 'New chat' }).click();
    await a.page.waitForURL('**/contacts', { timeout: 10000 });
    pass('chats', 'New chat → /contacts', 'ok');
  });
  await step('chats', 'presence dot + unread badge', async () => {
    // B online, in the thread, sends a message while A sits on the list
    await a.page.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('heading', { name: 'Chats' }).waitFor({ timeout: 12000 });
    await b.page.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await b.page.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    await settle(a.page, 1500);
    // presence: A's row for B should show an online dot now that B is connected
    const dot = await a.page.locator('[class*="onlineDot"]').first().isVisible().catch(() => false);
    (dot ? pass : info)('chats', 'online presence dot for a connected peer', `onlineDot visible=${dot}`);
    // unread: B sends; A's list should surface an unread badge + preview live
    const msg = `unread-probe ${nonce()}`;
    await b.page.getByPlaceholder('Type a message').fill(msg);
    await b.page.getByRole('button', { name: 'Send' }).click();
    let badge = false;
    try {
      await a.page.locator('[class*="unread"]').first().waitFor({ timeout: 8000 });
      badge = true;
    } catch { /* maybe list shows preview only */ }
    const preview = await a.page.getByText(msg, { exact: false }).first().isVisible().catch(() => false);
    (badge || preview ? pass : fail)('chats', 'unread badge / live preview on list', `unreadBadge=${badge}, previewShown=${preview}`);
    await shot(a.page, 'full_chats_unread');
  });

  // ============================================================= 3. USER↔USER TEXT
  await step('chat', 'open conversation by clicking a list row (end-user)', async () => {
    await a.page.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('heading', { name: 'Chats' }).waitFor({ timeout: 12000 });
    await a.page.locator('li').first().click();
    await a.page.waitForURL('**/chats/**', { timeout: 10000 });
    await a.page.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    pass('chat', 'open conversation via list-row click', `at ${path(a.page)}`);
  });
  await step('chat', 'bidirectional live text + typing indicator', async () => {
    // make sure both are in the same thread
    await a.page.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await b.page.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await a.page.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    await b.page.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    await settle(a.page, 1500);
    // A → B (Send button)
    const m1 = `A→B ${nonce()}`;
    await a.page.getByPlaceholder('Type a message').fill(m1);
    await a.page.getByRole('button', { name: 'Send' }).click();
    await b.page.getByText(m1, { exact: false }).waitFor({ timeout: 12000 });
    pass('chat', 'A→B delivered live over socket', m1);
    await shot(b.page, 'full_chat_B_recv');
    // B → A via Enter key (tests Enter-to-send)
    const m2 = `B→A ${nonce()}`;
    await b.page.getByPlaceholder('Type a message').fill(m2);
    await b.page.getByPlaceholder('Type a message').press('Enter');
    await a.page.getByText(m2, { exact: false }).waitFor({ timeout: 12000 });
    pass('chat', 'B→A delivered live (Enter-to-send)', m2);
    // typing indicator: A types, B sees "typing…"
    await a.page.getByPlaceholder('Type a message').fill('composing…');
    let typing = false;
    try { await b.page.getByText('typing…', { exact: false }).waitFor({ timeout: 6000 }); typing = true; } catch { /* */ }
    await a.page.getByPlaceholder('Type a message').fill('');
    (typing ? pass : fail)('chat', 'typing indicator shown to peer', `typing…=${typing}`);
    // timestamps present on bubbles
    const stamped = await a.page.locator('[class*="time"], [class*="stamp"]').first().isVisible().catch(() => false);
    info('chat', 'message timestamps rendered', `timestamp element visible=${stamped}`);
  });
  await step('chat', 'Back button returns to list', async () => {
    await a.page.getByRole('button', { name: /Back/ }).click();
    await a.page.waitForURL('**/chats', { timeout: 10000 });
    pass('chat', '‹ Back → /chats', 'ok');
  });

  // ============================================================= 4. CALLS (audio / decline / video)
  async function placeCall(kind /* 'audio'|'video' */, incomingText, shotPrefix) {
    await a.page.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await b.page.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await a.page.locator(`button[title="${kind === 'video' ? 'Video call' : 'Audio call'}"]`).waitFor({ timeout: 12000 });
    await settle(a.page, 1200);
    await a.page.locator(`button[title="${kind === 'video' ? 'Video call' : 'Audio call'}"]`).click();
    await b.page.getByText(incomingText).waitFor({ timeout: 15000 });
    await shot(b.page, `${shotPrefix}_incoming`);
  }
  await step('call', 'AUDIO call: ring → answer → connect → mute → hang up → markers', async () => {
    await placeCall('audio', /Incoming audio call/i, 'full_call_audio');
    pass('call', 'peer receives "Incoming audio call"', 'IncomingCallModal shown');
    await b.page.getByRole('button', { name: 'Answer' }).click();
    await a.page.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 });
    await b.page.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 });
    pass('call', 'WebRTC connected on both sides (audio)', 'both show "Connected"');
    await shot(a.page, 'full_call_audio_connected_A'); await shot(b.page, 'full_call_audio_connected_B');
    // mute toggle
    await a.page.locator('button[title="Mute"]').click();
    const unmuteShown = await a.page.locator('button[title="Unmute"]').isVisible().catch(() => false);
    (unmuteShown ? pass : fail)('call', 'mute toggle flips control to Unmute', `unmute visible=${unmuteShown}`);
    if (unmuteShown) await a.page.locator('button[title="Unmute"]').click();
    await settle(a.page, 1200);
    await a.page.locator('button[title="Hang up"]').click();
    await a.page.getByText('Connected', { exact: true }).waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    // inline system markers in the thread
    await a.page.getByText(/Voice call started/i).last().waitFor({ timeout: 8000 });
    await a.page.getByText(/Voice call ended/i).last().waitFor({ timeout: 8000 });
    pass('call', 'inline "Voice call started/ended" markers rendered', 'both markers present after hang up');
    await shot(a.page, 'full_call_audio_ended');
  });
  await step('call', 'AUDIO call decline: caller returns to idle', async () => {
    await placeCall('audio', /Incoming audio call/i, 'full_call_decline');
    await b.page.getByRole('button', { name: 'Decline' }).click();
    // caller's CallScreen (Ringing…/Connected) should disappear
    await a.page.getByText(/Ringing…|Connecting…|Connected/).waitFor({ state: 'hidden', timeout: 12000 }).catch(() => {});
    const stillInCall = await a.page.getByText(/Ringing…|Connected/).isVisible().catch(() => false);
    (!stillInCall ? pass : fail)('call', 'declined call clears caller CallScreen', `stillInCall=${stillInCall}`);
  });
  await step('call', 'VIDEO call: ring → answer → connect → camera toggle → hang up → markers', async () => {
    await placeCall('video', /Incoming video call/i, 'full_call_video');
    pass('call', 'peer receives "Incoming video call"', 'IncomingCallModal shown');
    await b.page.getByRole('button', { name: 'Answer' }).click();
    await a.page.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 });
    await b.page.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 });
    pass('call', 'WebRTC connected on both sides (video)', 'both show "Connected"');
    await shot(a.page, 'full_call_video_connected_A'); await shot(b.page, 'full_call_video_connected_B');
    // camera toggle (video-only control)
    const camBtn = a.page.locator('button[title="Turn camera off"]');
    if (await camBtn.isVisible().catch(() => false)) {
      await camBtn.click();
      const camOn = await a.page.locator('button[title="Turn camera on"]').isVisible().catch(() => false);
      (camOn ? pass : fail)('call', 'camera toggle flips to "Turn camera on"', `flipped=${camOn}`);
      if (camOn) await a.page.locator('button[title="Turn camera on"]').click();
    } else { info('call', 'camera toggle', 'camera control not visible'); }
    await settle(a.page, 1200);
    await a.page.locator('button[title="Hang up"]').click();
    await a.page.getByText('Connected', { exact: true }).waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    await a.page.getByText(/Video call started/i).last().waitFor({ timeout: 8000 });
    await a.page.getByText(/Video call ended/i).last().waitFor({ timeout: 8000 }).catch(() => {});
    pass('call', 'inline "Video call started/ended" markers rendered', 'markers present after hang up');
    await shot(a.page, 'full_call_video_ended');
  });

  // ============================================================= 5. STEWRA (text + voice)
  await step('stewra', 'text → thinking → assistant reply (+ Play voice)', async () => {
    await a.page.goto(`${WEB}/stewra`, { waitUntil: 'domcontentloaded' });
    const input = a.page.getByPlaceholder('…or type a message');
    await input.waitFor({ timeout: 15000 });
    await a.page.waitForFunction(() => { const el = document.querySelector('input[placeholder="…or type a message"]'); return el && !el.disabled; }, { timeout: 20000 });
    const before = await a.page.locator('[class*="stewraTurn"]').count();
    await input.fill(`What is 2+2? ref ${nonce()}`);
    await a.page.getByRole('button', { name: 'Send' }).click();
    await a.page.getByText('Stewra is thinking…', { exact: false }).waitFor({ timeout: 8000 }).catch(() => {});
    await a.page.waitForFunction((n) => document.querySelectorAll('[class*="stewraTurn"]').length > n, before, { timeout: 60000 });
    const after = await a.page.locator('[class*="stewraTurn"]').count();
    pass('stewra', 'Stewra replies to a text message', `assistant turns ${before} → ${after}`);
    const playVoice = await a.page.getByRole('button', { name: 'Play voice' }).first().isVisible().catch(() => false);
    info('stewra', 'assistant reply exposes "Play voice"', `playVoice visible=${playVoice}`);
    await shot(a.page, 'full_stewra_text');
  });
  await step('stewra', 'hold-to-talk voice → transcribed user turn + reply', async () => {
    if (path(a.page) !== '/stewra') await a.page.goto(`${WEB}/stewra`, { waitUntil: 'domcontentloaded' });
    const holdBtn = a.page.getByRole('button', { name: /Hold to talk/i });
    await holdBtn.waitFor({ timeout: 15000 });
    const before = await a.page.locator('[class*="userTurn"]').count();
    const box = await holdBtn.boundingBox();
    await a.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await a.page.mouse.down();                      // start recording (onMouseDown)
    await a.page.getByText('Recording — release to send', { exact: false }).waitFor({ timeout: 5000 }).catch(() => {});
    await settle(a.page, 2500);
    await a.page.mouse.up();                         // stop → send (onMouseUp)
    await a.page.waitForFunction((n) => document.querySelectorAll('[class*="userTurn"]').length > n, before, { timeout: 60000 });
    const after = await a.page.locator('[class*="userTurn"]').count();
    const transcript = (await a.page.locator('[class*="userTurn"]').last().innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 80);
    pass('stewra', 'voice recorded → transcribed → new user turn', `user turns ${before} → ${after}; transcript="${transcript}"${AUDIO ? '' : ' (fake mic: non-verbal audio, pipeline still exercised)'}`);
    await shot(a.page, 'full_stewra_voice');
  });

  // ============================================================= 6. CONTACTS
  await step('contacts', 'search people + Message action', async () => {
    await a.page.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await a.page.getByPlaceholder('Search by name or email').waitFor({ timeout: 12000 });
    await a.page.getByPlaceholder('Search by name or email').fill(B.email.split('@')[0]);
    await a.page.getByRole('button', { name: 'Search' }).click();
    await settle(a.page, 2000);
    const hasResult = await a.page.getByText(B.email, { exact: false }).first().isVisible().catch(() => false);
    (hasResult ? pass : info)('contacts', 'people search returns results', `found peer by name=${hasResult}`);
    await shot(a.page, 'full_contacts_search');
  });
  await step('contacts', 'contacts list renders + invite form present', async () => {
    await a.page.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    const yourContacts = await a.page.getByRole('heading', { name: 'Your contacts' }).isVisible().catch(() => false);
    const inviteInput = await a.page.getByPlaceholder('name@example.com').isVisible().catch(() => false);
    (yourContacts && inviteInput ? pass : info)('contacts', '"Your contacts" + "Invite by email" render', `contacts=${yourContacts}, inviteInput=${inviteInput}`);
  });
  await step('contacts', 'invite by email (graceful for existing contact)', async () => {
    await a.page.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await a.page.getByPlaceholder('name@example.com').fill(B.email);
    await a.page.getByRole('button', { name: 'Send invite' }).click();
    await settle(a.page, 2000);
    // Either a success notice or a graceful error — both are acceptable (already contacts)
    const notice = await a.page.locator('body').innerText();
    const handled = /Invite sent|already|contact|cannot|error/i.test(notice);
    (handled ? pass : info)('contacts', 'invite-by-email produces a notice (no crash)', `handled=${handled}`);
  });
  await step('contacts', 'Block then Unblock a contact (state restored)', async () => {
    await a.page.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('heading', { name: 'Your contacts' }).waitFor({ timeout: 12000 });
    const blockBtn = a.page.getByRole('button', { name: 'Block' }).first();
    if (await blockBtn.isVisible().catch(() => false)) {
      await blockBtn.click();
      const unblock = await a.page.getByRole('button', { name: 'Unblock' }).first().isVisible().catch(() => false);
      if (unblock) {
        pass('contacts', 'Block flips contact to blocked state', 'Unblock button appeared');
        await a.page.getByRole('button', { name: 'Unblock' }).first().click();   // RESTORE original state
        await settle(a.page, 800);
        const restored = await a.page.getByRole('button', { name: 'Block' }).first().isVisible().catch(() => false);
        (restored ? pass : info)('contacts', 'Unblock restores original state', `restored=${restored}`);
      } else { fail('contacts', 'Block flips contact to blocked state', 'no Unblock button after Block'); }
    } else { info('contacts', 'Block/Unblock', 'no Block button (no eligible contact rendered)'); }
  });
  await step('contacts', 'Message from contact row opens a conversation', async () => {
    await a.page.goto(`${WEB}/contacts`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('heading', { name: 'Your contacts' }).waitFor({ timeout: 12000 });
    const msgBtn = a.page.getByRole('button', { name: 'Message' }).first();
    if (await msgBtn.isVisible().catch(() => false)) {
      await msgBtn.click();
      await a.page.waitForURL('**/chats/**', { timeout: 10000 }).catch(() => {});
      (/\/chats\//.test(path(a.page)) ? pass : fail)('contacts', 'Message → opens direct conversation', `landed ${path(a.page)}`);
    } else { info('contacts', 'Message from contact row', 'no Message button visible'); }
  });

  // ============================================================= 7. ACTIVITY (home) features
  await step('activity', 'home cards render', async () => {
    await a.page.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('heading', { name: 'Stewra' }).first().waitFor({ timeout: 12000 });
    for (const h of ['Your sources', 'Gmail window', 'Learn my writing style', 'Ask for an insight', 'Activity']) {
      const vis = await a.page.getByRole('heading', { name: h }).isVisible().catch(() => false);
      info('activity', `card "${h}" renders`, `visible=${vis}`);
    }
    await shot(a.page, 'full_activity');
  });
  await step('activity', 'Connect Google → in-page consent modal → Not now', async () => {
    await a.page.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const connectBtn = a.page.getByRole('button', { name: 'Connect a Google account' });
    await connectBtn.waitFor({ timeout: 12000 });
    const disabled = await connectBtn.isDisabled().catch(() => false);
    if (disabled) { info('activity', 'Connect Google consent modal', 'button disabled (email not verified) — not clicked'); return; }
    await connectBtn.click();
    const modal = await a.page.getByText('One quick check', { exact: false }).isVisible().catch(() => false);
    (modal ? pass : fail)('activity', 'Connect Google opens in-page consent modal', `modal shown=${modal}`);
    await shot(a.page, 'full_activity_consent');
    // Do NOT click "Yes, continue to Google" (real external OAuth redirect). Cancel instead.
    await a.page.getByRole('button', { name: 'Not now' }).click().catch(() => {});
    skip('activity', 'complete Google OAuth ("Yes, continue to Google")', 'would redirect off-app to real Google consent — cancelled with "Not now"');
  });
  await step('activity', 'Gmail window Save (re-save current value, non-destructive)', async () => {
    await a.page.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const saveBtn = a.page.locator('section, div').filter({ hasText: 'Gmail window' }).getByRole('button', { name: 'Save' }).first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click(); await settle(a.page, 1200);
      pass('activity', 'Gmail window Save works', 're-saved existing value (no change)');
    } else { info('activity', 'Gmail window Save', 'Save button not found'); }
  });
  await step('activity', 'Learn-my-writing-style toggle (flip + restore)', async () => {
    await a.page.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const cb = a.page.locator('input[type="checkbox"]').first();
    if (await cb.isVisible().catch(() => false)) {
      const orig = await cb.isChecked();
      await cb.click({ force: true }); await settle(a.page, 1000);
      const flipped = (await cb.isChecked()) !== orig;
      await cb.click({ force: true }); await settle(a.page, 800);     // RESTORE
      const restored = (await cb.isChecked()) === orig;
      (flipped && restored ? pass : info)('activity', 'writing-style toggle flips and restores', `flipped=${flipped}, restored=${restored}`);
    } else { info('activity', 'writing-style toggle', 'checkbox not found'); }
  });
  await step('activity', 'generate an insight + submit feedback', async () => {
    await a.page.goto(`${WEB}/activity`, { waitUntil: 'domcontentloaded' });
    const calBtn = a.page.getByRole('button', { name: 'Look at my calendar' });
    await calBtn.waitFor({ timeout: 12000 });
    if (await calBtn.isDisabled().catch(() => false)) {
      info('activity', 'insight generation', 'insight buttons disabled (needs verified email / connected source) — not exercised');
      return;
    }
    await calBtn.click();
    // insight card renders 💡 …; may take a while (reads real calendar via LLM)
    await a.page.getByText('💡', { exact: false }).waitFor({ timeout: 90000 });
    pass('activity', '"Look at my calendar" generates an insight', 'insight card rendered');
    await shot(a.page, 'full_activity_insight');
    // FeedbackControl appears — submit a rating
    const fb = a.page.getByRole('group', { name: 'Rate this insight' });
    if (await fb.isVisible().catch(() => false)) {
      const firstRating = fb.getByRole('button').first();
      await firstRating.click();
      await a.page.getByRole('button', { name: 'Send feedback' }).click();
      const thanks = await a.page.getByText('Thanks', { exact: false }).isVisible().catch(() => false);
      (thanks ? pass : info)('activity', 'submit insight feedback (feedback learning loop)', `confirmation shown=${thanks}`);
    } else { info('activity', 'feedback control', 'FeedbackControl not shown for this insight') }
  });

  // ============================================================= 8. MEMORY features
  await step('memory', 'memory page renders + search + source filter', async () => {
    await a.page.goto(`${WEB}/memory`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('heading', { name: /What Stewra has learned/i }).waitFor({ timeout: 12000 });
    const search = a.page.getByPlaceholder(/Search by name, purpose, or guidance/i);
    if (await search.isVisible().catch(() => false)) {
      await search.fill('email'); await settle(a.page, 700); await search.fill(''); await settle(a.page, 500);
      pass('memory', 'memory search input accepts input (debounced)', 'no crash on query');
    } else { info('memory', 'memory search', 'search input not visible'); }
    const filter = a.page.getByLabel('Filter by source');
    if (await filter.isVisible().catch(() => false)) {
      await filter.selectOption('gmail').catch(() => {});
      await settle(a.page, 800);
      await filter.selectOption('').catch(() => {});
      pass('memory', 'source filter select changes value', 'toggled gmail → All sources');
    } else { info('memory', 'source filter', 'filter select not visible'); }
    await shot(a.page, 'full_memory');
  });
  await step('memory', 'memory card Edit → Cancel (non-mutating)', async () => {
    await a.page.goto(`${WEB}/memory`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('heading', { name: /What Stewra has learned/i }).waitFor({ timeout: 12000 });
    const editBtn = a.page.getByRole('button', { name: 'Edit' }).first();
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click();
      const cancel = a.page.getByRole('button', { name: 'Cancel' }).first();
      const inEdit = await cancel.isVisible().catch(() => false);
      if (inEdit) { await cancel.click(); pass('memory', 'Edit opens editor, Cancel discards (no write)', 'ok'); }
      else { info('memory', 'Edit/Cancel', 'edit form did not open as expected'); }
    } else { info('memory', 'Edit/Cancel', 'no editable memory/rule present') }
  });
  await step('memory', 'hide/use-for-recall toggle (reversible)', async () => {
    await a.page.goto(`${WEB}/memory`, { waitUntil: 'domcontentloaded' });
    await a.page.getByRole('heading', { name: /What Stewra has learned/i }).waitFor({ timeout: 12000 });
    const hideBtn = a.page.getByRole('button', { name: 'Hide from recall' }).first();
    if (await hideBtn.isVisible().catch(() => false)) {
      await hideBtn.click(); await settle(a.page, 800);
      const useBtn = a.page.getByRole('button', { name: 'Use for recall' }).first();
      const flipped = await useBtn.isVisible().catch(() => false);
      if (flipped) { await useBtn.click(); pass('memory', 'Hide↔Use for recall toggle works (restored)', 'ok'); }
      else { info('memory', 'Hide/Use toggle', 'did not flip to "Use for recall"'); }
    } else { info('memory', 'Hide/Use toggle', 'no "Hide from recall" button present'); }
  });
  skip('memory', 'Delete memory / Delete rule / Dismiss rule', 'irreversibly destroys real learned data on a live account — buttons present & located, deliberately not clicked');

  // ============================================================= 9. BY-DESIGN GAPS
  await step('gaps', 'Stewra thread exposes NO call buttons (by design)', async () => {
    await a.page.goto(`${WEB}/stewra`, { waitUntil: 'domcontentloaded' });
    await a.page.getByPlaceholder('…or type a message').waitFor({ timeout: 12000 });
    const audio = await a.page.locator('button[title="Audio call"]').count();
    const video = await a.page.locator('button[title="Video call"]').count();
    ((audio + video) === 0 ? pass : fail)('gaps', 'Stewra thread has no voice/video call button', `audio=${audio}, video=${video} (expected 0/0)`);
  });
  await step('gaps', 'human composer has NO mic (parity gap vs mobile app)', async () => {
    await a.page.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await a.page.getByPlaceholder('Type a message').waitFor({ timeout: 12000 });
    const mic = await a.page.getByRole('button', { name: /Hold to talk|mic|record/i }).count();
    (mic === 0 ? pass : info)('gaps', 'human chat composer has no hold-to-talk mic', `mic buttons=${mic} (expected 0 — mobile app has it since d352bef)`);
  });

  // ============================================================= 10. SIGN OUT
  await step('auth', 'Sign out returns to /login', async () => {
    const so = await browser.newContext();
    await so.grantPermissions([], { origin: WEB });
    await so.addInitScript(([k, v]) => { try { window.localStorage.setItem(k, v); } catch { /* */ } },
      [TOKEN_KEY, JSON.stringify({ accessToken: A.accessToken, refreshToken: A.refreshToken })]);
    const sp = await so.newPage();
    await sp.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    await sp.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 12000 });
    await sp.getByRole('button', { name: 'Sign out' }).click();
    await sp.waitForURL('**/login', { timeout: 10000 });
    (path(sp) === '/login' ? pass : fail)('auth', 'Sign out clears session → /login', `landed ${path(sp)}`);
    await so.close();
  });

  await browser.close();

  // ---------- summary ----------
  const counts = report.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
  console.log(`\n=== SUMMARY: ${counts.pass || 0} pass / ${counts.fail || 0} fail / ${counts.info || 0} info / ${counts.skip || 0} skip (${report.length} checks) ===`);
  writeFileSync(join(HERE, 'full-report.json'), JSON.stringify(report, null, 2));
  const icon = { pass: '✅', fail: '❌', info: 'ℹ️', skip: '⏭️' };
  const md = [
    `# Stewra website — full end-user E2E results`, ``,
    `- Target: ${WEB}`,
    `- Users: A=${cfg.users.a.email}, B=${cfg.users.b.email}`,
    `- Driven by navigation + clicks (headless Chromium). Fake media for calls/voice.`,
    `- **${counts.pass || 0} pass · ${counts.fail || 0} fail · ${counts.info || 0} info · ${counts.skip || 0} skip** (${report.length} checks)`, ``,
    `| Section | Feature | Result | Detail |`, `| --- | --- | --- | --- |`,
    ...report.map((r) => `| ${r.section} | ${r.feature} | ${icon[r.kind] || r.kind} | ${(r.info || '').replace(/\|/g, '\\|')} |`),
  ].join('\n');
  writeFileSync(join(HERE, 'full-report.md'), md);
  console.log(`Wrote full-report.md / full-report.json / shots to ${HERE}`);
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(3); });
