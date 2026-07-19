# Website E2E suite

End-to-end tests that drive the **real Stewra website** in headless Chromium with the
real [`@playwright/test`](https://playwright.dev/) runner. They seed **two authenticated
user sessions** at once, so they can exercise flows a single-device test can't — most
importantly two-party WebRTC calls (User A calls User B, both ends assert `Connected`).

This is the web counterpart to [`frontend/e2e/`](../../frontend/e2e/) (Maestro, one
device). Because auth lives in `localStorage["stewra.tokens"]` (per-origin, shared across
tabs), the two users can't coexist in one browser context — every test gets its own
context per user (`ctxA`/`ctxB`), seeded before its first navigation.

## Prerequisites

- **Node 18+** and this folder's deps: `npm install` (its `postinstall` runs
  `playwright install chromium`).
- **Two email-verified QA users who are contacts of each other**, identified by
  **email + password** (no pasted tokens — the suite logs in via the real API once per
  worker and mints fresh short-lived tokens itself). A `direct` conversation can only be
  created between contacts, and every page sits behind email verification.
- For call tests: **no phone/emulator signed in as either QA user.** Incoming calls fan
  out to every logged-in device; a signed-in device collides with the browser↔browser
  handshake (`setRemoteDescription… wrong state: stable`). Sign mobile devices out first
  with [`frontend/e2e/scripts/reset-devices.sh`](../../frontend/e2e/scripts/reset-devices.sh).

## Configuration (never hardcoded)

`config.mjs` reads from environment variables **or** the single untracked repo-root
[`.env.e2e`](../../.env.e2e.example) (shared with the Maestro mobile suite) — env wins.
Required values throw loudly if missing, so a run can't silently target the wrong host or
authenticate as the wrong user.

| Variable | Required | Meaning |
| --- | --- | --- |
| `E2E_WEB_URL` | ✅ | Site under test, e.g. `https://www.stewra.com`. |
| `E2E_API_URL` | — | API base. Defaults to `${E2E_WEB_URL}/api` (nginx strips `/api` in prod). |
| `E2E_AUDIO_FILE` | — | 16 kHz mono WAV fed to WebRTC as fake mic input, so speech-to-text yields a real transcript. |
| `E2E_USER_A_EMAIL` / `E2E_USER_A_PASSWORD` | ✅ | User A's login credentials. |
| `E2E_USER_B_EMAIL` / `E2E_USER_B_PASSWORD` | ✅ | User B's login credentials. |

```bash
cp ../../.env.e2e.example ../../.env.e2e   # repo-root, gitignored — fill in real values
```

Each worker calls `/auth/login` once for A and once for B (`loginAll()` in `lib.mjs`) and
ensures their direct conversation exists, before any test in that worker runs — see the
worker-scoped `session` fixture in `fixtures.ts`.

## Run

```bash
npm run test:e2e           # headless, both projects (desktop + mobile viewport)
npm run test:e2e:headed    # same, with a visible browser
npm run test:e2e:ui        # Playwright's interactive UI mode
npm run test:e2e:report    # open the last HTML report
npm run type-check:e2e     # tsc --noEmit over the whole e2e/ folder
```

`playwright.config.ts` runs two projects against every spec in `tests/`:

| Project | Viewport | What it covers |
| --- | --- | --- |
| `desktop-chromium` | 1180×860 | The primary desktop experience. |
| `mobile-chromium` | Pixel 7 emulation | The responsive pass — the mobile-web viewport RN-app users also hit on the web. |

`workers: 1` and `retries: 1` are intentional: the two QA sessions are shared, real
production accounts (there is no separate dev DB), so tests must not race each other.
Fake-media launch args (`--use-fake-device-for-media-stream`,
`--use-fake-ui-for-media-stream`, plus `E2E_AUDIO_FILE` if set) make WebRTC + voice work
headless with no real hardware.

Results land in `.artifacts/` (gitignored): `report/` for the HTML report (`npm run
test:e2e:report` opens it), `results.json`, traces/videos/screenshots on failure, and raw
`test-results/`.

## What each spec covers

| Spec | Ported from | What it checks |
| --- | --- | --- |
| `tests/auth.spec.ts` | `full.mjs` §1 (auth) | Unauthenticated redirect to `/login`, login page rendering, register-mode Name field, per-user session validity, sign-out. |
| `tests/nav.spec.ts` | `full.mjs` §1 (nav) | Home→messaging reachability, AppNav click-through, Activity↔Memory round-trip, unknown-route→`/today` catch-all. |
| `tests/chats.spec.ts` | `full.mjs` §2 | Conversation list rendering, "New chat"→Contacts, live presence dot + unread badge. |
| `tests/chat.spec.ts` | `full.mjs` §3 | Opening a conversation by row click, bidirectional live text (Send button + Enter-to-send), typing indicator, message timestamps, Back navigation. |
| `tests/calls.spec.ts` | `full.mjs` §4, `calls.audio.mjs`, `calls.video.mjs` | Full audio call (ring→answer→connect→mute→hang up→inline markers), decline flow, full video call (+ camera toggle), and N-attempt fresh-context connect-reliability probes for both kinds. |
| `tests/stewra.spec.ts` | `full.mjs` §5 | Text→assistant reply on `/stewra`, hold-to-talk voice→transcribed turn. |
| `tests/contacts.spec.ts` | `full.mjs` §6 | People search, contacts list + invite form, invite-by-email, Block↔Unblock, Message-from-row deep link. |
| `tests/activity.spec.ts` | `full.mjs` §7 | Home cards, Google-connect consent modal (cancelled, never completes real OAuth), Gmail-window save, writing-style toggle, insight generation + feedback. |
| `tests/memory.spec.ts` | `full.mjs` §8 | Memory page render/search/filter, Edit→Cancel, Hide↔Use-for-recall toggle. |
| `tests/gaps.spec.ts` | `full.mjs` §9 | By-design product gaps, asserted as real (hard) checks: no call buttons on the Stewra thread, no mic on the human composer. |
| `tests/today.spec.ts` | `today.mjs` | The proactive `/today` home: greeting, briefing card vs. backend truth, nudge list vs. backend suggestions, expand/draft/snooze/dismiss/chat-about-this, AppNav order, console-error-free navigation. |

## Safety: destructive / external-OAuth flows are skipped, not omitted

A few flows are real product features but unsafe to fully exercise against a live account
with `workers: 1` accounts. These use `test.skip(condition, reason)` (visible in the report
as **skipped**, not passed or failed) with the original safety reasoning preserved:

- **Email sign-up / verification** (`auth.spec.ts`) — no throwaway inbox available.
- **Completing Google OAuth** (`activity.spec.ts`) — the in-page consent modal is opened
  and asserted, then cancelled with "Not now" rather than following the real external
  Google redirect.
- **Delete memory / Delete rule / Dismiss rule** (`memory.spec.ts`) — irreversibly
  destroys real learned data on a live account; located but never clicked.

## `data-testid` contract

Some checks now target stable `data-testid` attributes instead of hashed CSS-module class
substrings (`[class*="…"]`). See [`TESTIDS.md`](./TESTIDS.md) for the full registry and
which `website/src` component owns each one.
