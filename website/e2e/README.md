# Website E2E suite

End-to-end tests that drive the **real Stewra website** in headless Chromium with
[Playwright](https://playwright.dev/). They seed **two authenticated user sessions**
at once, so they can exercise the flows a single-device test can't — most importantly
two-party WebRTC calls (User A calls User B, both ends assert `Connected`).

This is the web counterpart to [`frontend/e2e/`](../../frontend/e2e/) (Maestro, one
device). Because auth lives in `localStorage["stewra.tokens"]` (per-origin, shared
across tabs), the two users can't coexist in one browser context — each runs in its
own isolated context, seeded before navigation.

## Prerequisites

- **Node 18+** and this folder's deps: `npm install` (its `postinstall` runs
  `playwright install chromium`).
- **Two email-verified test users who are contacts of each other.** A `direct`
  conversation can only be created between contacts, and every page sits behind email
  verification. You need each user's `accessToken` **and** `refreshToken`.
- For call tests: **no phone/emulator signed in as either test user.** Incoming calls
  fan out to every logged-in device; a signed-in device collides with the
  browser↔browser handshake (`setRemoteDescription… wrong state: stable`). Sign mobile
  devices out first with [`frontend/e2e/scripts/reset-devices.sh`](../../frontend/e2e/scripts/reset-devices.sh).

## Configuration (never hardcoded)

`config.mjs` reads from environment variables **or** an untracked `e2e.config.json`;
env wins. Required values throw loudly if missing, so a run can't silently target the
wrong host or authenticate as the wrong user. Pick one:

**A. Env vars (CI-friendly):**

| Variable | Required | Meaning |
| --- | --- | --- |
| `E2E_WEB_URL` | ✅ | Site under test, e.g. `https://www.stewra.com`. |
| `E2E_API_URL` | — | API base. Defaults to `${E2E_WEB_URL}/api` (nginx strips `/api` in prod). |
| `E2E_AUDIO_FILE` | — | 16 kHz mono WAV fed to WebRTC as fake mic input, so speech-to-text yields a real transcript. |
| `E2E_USER_A_ACCESS` / `E2E_USER_A_REFRESH` | ✅ | User A's tokens. |
| `E2E_USER_A_EMAIL` | — | Label only, for report readability. |
| `E2E_USER_B_ACCESS` / `E2E_USER_B_REFRESH` | ✅ | User B's tokens. |
| `E2E_USER_B_EMAIL` | — | Label only. |

**B. Local file:**

```bash
cp e2e.config.example.json e2e.config.json   # e2e.config.json is gitignored
# fill in webUrl + both users' tokens
```

Access tokens are short-lived; the suite calls `/auth/refresh` up front, so keep the
**refresh** tokens fresh.

## Run

```bash
npm run full     # full feature matrix (nav-driven, one browser, both users)
npm run audio    # audio-call connect probe ×3 (fresh context pair per attempt)
npm run video    # video-call connect probe ×3
npm run calls    # audio then video
npm run all      # full matrix, then audio, then video, with a pass/fail summary
```

`calls.audio.mjs` / `calls.video.mjs` take an attempt count: `node calls.audio.mjs 5`.

## What each script covers

| Script | npm | What it checks |
| --- | --- | --- |
| `full.mjs` | `full` | Every website feature by real navigation + clicks: auth bootstrap, user↔user chat (live socket delivery, typing, unread), user↔Stewra text, user↔Stewra voice-to-text, and the two documented gaps. Each feature is isolated in its own try/catch and emits `pass`/`fail`/`info`/`skip(reason)`; writes `full-report.md` + `.json` and screenshots to `shots/`. |
| `calls.audio.mjs` | `audio` | A calls B over audio; asserts B's incoming-call modal, answer, and **both** ends reach `Connected`. Reports a connect-success rate over N fresh attempts. |
| `calls.video.mjs` | `video` | Same as audio, for video calls. |
| `run-all.mjs` | `all` | Runs the three above as separate processes (one crash can't sink the rest) and prints a summary. |

## Documented gaps (reported, not failed)

Two requested flows aren't testable because the product doesn't offer them — the suite
records them as `skip`/`info`, not `fail`:

- **Voice-to-text user↔user** — the human chat composer (`ConversationPage`) is
  text-only; hold-to-talk voice compose exists only on the Stewra page. (The mobile app
  gained it in `d352bef`; the website hasn't — the one genuine parity gap, a possible
  follow-up build.)
- **Voice/video call user↔Stewra** — unsupported by design; the backend
  (`callService.resolveDirectCallee`) rejects calling Stewra and the Stewra thread shows
  no call buttons.

## Artifacts

`shots/*.png`, `full-report.md`, `full-report.json`, and `report/` / `artifacts/` are
all gitignored — safe to leave after a run.
