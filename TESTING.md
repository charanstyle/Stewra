# Testing Stewra

This is the single entry point for **how we test Stewra**. The philosophy, borrowed from the
Truetalk project, is: **verify against the real running system through the real UI** — never a
synthetic harness that only proves itself. Two UI e2e stacks cover the two user-facing surfaces,
backed by fast unit suites underneath.

| Surface | Layer | Tool | Where |
| --- | --- | --- | --- |
| Backend / bridge | unit / integration | **Vitest** (real DB, bcrypt, config; no mocks) | `backend/src/tests/`, `bridge/src/tests/` |
| Website | UI e2e | **@playwright/test** (headless Chromium, two live sessions) | `website/e2e/` |
| Mobile (RN) | UI e2e | **Maestro** (real device/emulator) | `frontend/e2e/` |

> **Golden rule (also in agent memory):** to confirm a web or mobile change works
> end-to-end, **run the existing suite below and extend its flows** — do not write a
> new one-off script. See `no-mocking-real-tests` / `live-testing-culture` / `e2e-testing-approach`.

---

## One shared credentials file

Both UI suites read a single untracked **`.env.e2e` at the repo root** (template: `.env.e2e.example`).
Copy it once and fill in the two QA users; real environment variables override the file, so CI can
inject the same names without a file.

```bash
cp .env.e2e.example .env.e2e     # gitignored — never commit real creds
# fill: E2E_WEB_URL, E2E_USER_A_EMAIL/PASSWORD, E2E_USER_B_EMAIL/PASSWORD, E2E_CONTACT_NAME
```

A run needs only the two QA **emails + passwords** — both suites log in for you (no pasted tokens).

## Ground rules for e2e (read before running)

- **Targets production by default** (`https://www.stewra.com`, API same-origin under `/api`). There is
  no separate dev DB — **the tunnelled "dev" DB *is* production with live users.** So e2e must run as
  **dedicated QA test accounts**, never real users.
- **You need two QA users** who are **mutual contacts** and **email-verified** — a `direct`
  conversation only exists between contacts, and every page sits behind email verification. The web
  call tests drive both as the two ends of one call. (The web suite auto-ensures the contact +
  conversation via the API on startup.)
- **Nothing is hardcoded.** URLs/creds come from `.env.e2e` or env vars; missing required values fail
  loudly.
- **Sign mobile devices out before web call tests.** Incoming calls fan out to every signed-in device;
  a logged-in phone breaks the browser↔browser WebRTC handshake. Run
  `frontend/e2e/scripts/reset-devices.sh` first.

---

## Unit / integration (Vitest)

```bash
npm test                 # root: runs backend + bridge Vitest suites
npm test -w backend
npm test -w @stewra/bridge
```

Real dependencies only — no `jest.mock`/stubs. A green Vitest run does **not** prove Node ESM↔CJS
interop; the bridge adds a `test:esm-interop` check for that.

---

## Website e2e (@playwright/test) — `website/e2e/`

Drives the real site in headless Chromium on the real `@playwright/test` runner. It logs both QA
users in via the API once per worker (no pasted tokens), seeds each into its own browser context
(auth is per-origin localStorage, so two users can't share one context), and exercises two-party
WebRTC calls (A calls B, both ends assert `Connected`) with fake-media flags.

```bash
cd website/e2e
npm install                 # postinstall pulls Chromium

npm run test:e2e            # whole suite, both projects (desktop + mobile-web viewport)
npm run test:e2e -- calls   # a single spec (e.g. calls.spec.ts)
npm run test:e2e:headed     # watch it drive a real browser
npm run test:e2e:ui         # Playwright UI mode
npm run test:e2e:report     # open the HTML report from the last run
npm run type-check:e2e      # typecheck the suite
```

Config: `website/e2e/playwright.config.ts` (two projects `desktop-chromium` + `mobile-chromium`,
`workers:1`, `retries:1`, HTML + JSON + list reporters into `.artifacts/`). Specs live in
`website/e2e/tests/*.spec.ts`; shared helpers in `lib.mjs`; the two-authenticated-context fixture in
`fixtures.ts`. Selectors that used to match hashed CSS-module classes now use stable `data-testid`s —
the registry is `website/e2e/TESTIDS.md`.

---

## Mobile e2e (Maestro) — `frontend/e2e/`

Drives the real app (`com.stewra.app`) on one device/emulator. Flows target the app's **`testID`
contract** (`frontend/e2e/TESTIDS.md`) for interactions and assert on human-readable screen text for
transitions. The call test is **caller-side smoke only** — two-party connect is delegated to the web
suite above.

```bash
# Prereqs: Maestro CLI, a build installed (npx expo run:android), adb, one device attached.
# Fill the repo-root .env.e2e (same file as the web suite).

frontend/e2e/run-all-features.sh android           # login → send → call smoke → logout, all flows
frontend/e2e/run-features.sh flows/send-message.yaml android   # a single flow (pins the device)
frontend/e2e/scripts/reset-devices.sh              # adb pm clear on every attached device (sign out)
```

`testID` is a plain prop change — edits hot-reload, no EAS rebuild needed.

---

## Deliberately out of scope (vs. Truetalk)

Truetalk also ships an **Appium/WebDriverAgent** harness (to automate a physically-connected real
iPhone that Maestro can't drive) and an **IMAP-OTP account-bootstrap** harness (to create accounts by
reading email/SMS one-time codes). Stewra skips both on purpose: we use pre-verified QA accounts with
password login, so neither earns its complexity here. Revisit only if we start testing a real iPhone
or need to create accounts from scratch in the suite.

## Not wired into CI

The suites are **run locally, one command each** (Truetalk's aren't in CI either). There is no
`.github/workflows/` running Playwright or Maestro yet.
