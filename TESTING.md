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
npm test                 # root: backend + bridge + runner + provisioner
npm test -w backend
npm test -w @stewra/bridge
npm test -w @stewra/runner
npm test -w @stewra/provisioner   # skipped without a Docker socket — see below
```

Real dependencies only — no `jest.mock`/stubs. A green Vitest run does **not** prove Node ESM↔CJS
interop; the bridge adds a `test:esm-interop` check for that.

---

## Bridge autostart — `bridge/src/tests/autostart.test.ts`

"Start at login" is the one setting whose failure is invisible: it does not break at the moment it is
switched on, it breaks at the next reboot, when the bridge is simply not there and Stewra has quietly
stopped relaying WhatsApp. So the suite asserts against **real files in a real directory**, never
against the intent to write one.

Electron's `app.setLoginItemSettings` is macOS/Windows only and a silent no-op on Linux, so the `deb`
and `AppImage` builds need a hand-written XDG entry (`~/.config/autostart/stewra-bridge.desktop`). The
Linux tests pass a `LoginItemAdapter` that **throws if touched**, which is what keeps the platform split
honest — a regression that routed Linux back through Electron's API would fail loudly here instead of
shipping a checkbox that does nothing.

What the suite pins down, each because getting it wrong produces a bridge that never comes back:

- the `Exec=` path is quoted, so the deb's `/opt/Stewra Bridge/stewra-bridge` launches at all;
- an AppImage entry names the `.AppImage` file, not the throwaway `/tmp` mount that will not exist next boot;
- an entry carrying `Hidden=true` or `X-GNOME-Autostart-enabled=false` reads as **off** — desktops switch
  an entry off by writing one of those rather than deleting the file, and `Hidden=true` is the freedesktop
  autostart spec's own disable, which conformant sessions *must* honour;
- re-enabling **replaces** a disabled entry outright, so no stale `Hidden=true` survives to produce a file
  that reads as enabled and still never launches;
- a development run **refuses** to enable (it would register Electron itself) but is still allowed to
  switch off, since that is how a bad entry gets cleared;
- macOS accepting a registration it has not yet approved reports **off**, because the read-back — not the
  value we asked for — is what the checkbox shows.

No Electron process is started: everything here is plain files and an injected adapter, so it runs in the
normal `npm test -w @stewra/bridge` pass.

The `Hidden=true` case above came from **running the real generated entry through a real session tool**
rather than from reading the spec: in a `debian:13` container, `dex --autostart` skipped an entry the code
still reported as enabled. Two other oracles were tried and rejected on the way, and both are worth not
repeating — `dex` ignores `X-GNOME-Autostart-enabled` because that key is GNOME-specific, and `gio launch`
honours neither key because it launches a named file directly instead of applying autostart filtering. A
tool that launches a `.desktop` file is not evidence about what a *session* does with it.

### The full-reboot check, and the two bugs only it could find

The file-level tests above cannot answer the question the feature is actually about: *does a real
graphical login start the bridge?* That was verified once, by hand, against a **Lima VM running Debian
13** with lightdm autologin into a real xfce session (`xserver-xorg-video-dummy`, because Lima's `vz`
VM has no GPU — which also means lightdm needs `logind-check-graphical=false`, or it waits forever for
a seat logind will never mark graphical). The real `.deb` was built inside that VM from the committed
lockfile, installed to `/opt/Stewra Bridge`, autostart switched on **through the app's own
renderer→IPC→main path**, then the VM was rebooted. After boot: `/opt/Stewra Bridge/stewra-bridge
--hidden` was running, started by nobody but the session, with no window on screen.

Two shipping bugs surfaced only there, both invisible to any test that stops at the file:

- **The `.deb` declared no ALSA dependency.** electron-builder's default `Depends` omits it, but
  Electron links `libasound.so.2`, so on a clean Debian 13 the app died at the loader with an error
  that never mentions audio. Fixed in `bridge/electron-builder.yml`; see the comment there before
  editing that list, since `depends` *replaces* the defaults rather than adding to them.
- **The bridge could not start on XFCE at all** — see below.

Re-running this by hand is only worth it when the autostart or packaging surface changes. It needs a
graphical login; Xvfb cannot substitute, because it has no display manager and therefore no login.

---

## The Linux keyring backend — `bridge/src/tests/keyStorageBackend.test.ts`

Chromium chooses its key storage backend from `XDG_CURRENT_DESKTOP`: libsecret on GNOME-like sessions,
kwallet on KDE, and its hardcoded-key `basic_text` store on anything it does not recognise. Since
`secretStore.ts` rightly **refuses** to run on `basic_text` (it is a single key shared by every copy of
the app, not encryption), the bridge could not start on XFCE, LXQt, i3 or sway *even with gnome-keyring
installed, running and unlocked* — and it said "no system keyring is running", which was simply untrue.
Same VM, same keyring, named the backend, started first try.

`linuxKeyStorageBackend()` is a pure function precisely so this is testable without booting Electron.
The two directions that must never break: **KDE is left alone** (kwallet is correct there, and real
sessions spell it `plasma:KDE`), and an explicit `--password-store=` from whoever launched the app
always wins. The choice can only widen where a real keyring is found — when libsecret is genuinely
missing, Chromium still lands on `basic_text` and the loud refusal still fires.

---

## Hosted cloud runners — `backend/src/tests/hostedRunnerService.test.ts`

Everything a hosted runner touches is real except Docker: the `stewra_test` Postgres, a scripted GitHub
that verifies every App JWT against the App's public key, a scripted **provisioner** that enforces the
Phase 2 contract (bearer token, exact image, env allowlist, 404/409), and the backend's own Express
router behind a real HTTP server for the device-token endpoints.

The scripted provisioner **refuses** what the real one refuses, which is the point of scripting it
rather than stubbing it: a backend that sends the wrong image, or an environment variable outside
`^STEWRA_(API_URL|API_PREFIX|RUNNER_[A-Z0-9_]+)$`, fails here instead of in production. Every refusal
is collected and asserted empty after each test, so an unexpected one fails whatever test caused it.

Docker itself is absent on purpose — the provisioner's own suite (below) drives a real daemon, which is
where container-level claims belong.

Two of these tests take real time and cannot be shortened honestly: waking polls until
`HOSTED_RUNNER_WAKE_TIMEOUT_SECONDS` elapses (pinned to 10s in the suite), because "gave up in time" is
the behaviour under test.

---

## Runner hosted mode — `runner/src/tests/`

Three suites cover what a Stewra-hosted container does that a paired laptop never does.

**`gitCredentialHelper.test.ts` — driven by real `git`.** The helper's consumer is
`git credential fill`: it reads the helper configuration, spawns the helper, speaks the protocol on
pipes, and parses the reply. Calling the helper directly would skip everything that can actually be
wrong — the shell-quoting of the configured command, the blank-line request terminator, the exact
reply keys — so these tests go through git itself, against a real HTTP server that **refuses** a
request without the device token exactly as the backend does.

Because git spawns the helper as a subprocess, it runs the *built* artifact. The suite therefore runs
`npm run build` in `beforeAll` (hence its ~2s floor) rather than trusting whatever is in `dist/`.

> If you write a test that pipes into a child here, use `spawn` and `child.stdin.end(input)`.
> `execFile` has **no** `input` option: its stdin pipe is opened and never closed, so a child that
> reads to end-of-input hangs until the test times out.

**`backendWorkspaces.test.ts` — real repositories over `file://`.** Proves a workspace list from the
backend becomes usable checkouts with the right base branch, that two repos sharing a name stay apart
on disk, and that a later boot fetches new commits. The sharpest assertion is the negative one: an
unreachable backend must **fail**, never report an empty list — "your GitHub App covers no
repositories" is a thing for the user to go fix, and the two must not look identical.

**`harnessCredentials.test.ts` — real slot files.** The `claude-code` → `CLAUDE_CODE_OAUTH_TOKEN`
mapping was verified end-to-end against the real `claude-agent-acp`, the real Claude Agent SDK and the
real `claude` CLI by recording the environment the CLI is spawned with. `codex` is deliberately
unmapped, and a slot written for it throws rather than being ignored.

---

## Provisioner suite (real Docker) — `provisioner/src/tests/`

The provisioner's claims are claims about what the **Docker daemon** accepts and produces — "CapDrop
is ALL", "there is no swap headroom", "the volumes die with the device", "a pasted provider token
lands mode 0600 owned by uid 10001". Nothing but a daemon can vouch for those, so this suite creates
real containers, inspects what Docker recorded, starts/stops them, writes and reads back a credential
file, and destroys everything it made (`afterAll` removes only the containers and volumes it created,
by name — it never sweeps by label).

**The gate.** With no Docker socket the whole suite is skipped *loudly*: it prints the reason and the
fix, and the run stays green so `npm test` at the root is usable on a machine without Docker. Socket
discovery is, in order: `DOCKER_SOCKET`, `/var/run/docker.sock`, `~/.docker/run/docker.sock` (Docker
Desktop), `~/.colima/default/docker.sock` (colima — it symlinks into neither of the other two, so
until that entry existed this page's "discovery finds the socket" promise was false on a machine with
colima running, and the suite skipped all 14 tests while a daemon sat right there).

**`DOCKER_SOCKET` disables the skip.** If it is set and the path does not exist, the suite FAILS
rather than skipping — "I pointed it at an engine" and "it quietly ran nothing" must not look alike.

Ways to give it a daemon:

```bash
# a) Docker Desktop / colima on the dev machine — nothing to configure, discovery finds the socket
npm test -w @stewra/provisioner

# b) a remote daemon over SSH (what to use when the dev machine has none). Forward the socket, then
#    point the suite at the local end. Test containers are created on THAT host — they are uniquely
#    named per run and removed in afterAll, but be deliberate about which host you pick.
ssh -nNT -L /tmp/stewra-docker.sock:/var/run/docker.sock home &
DOCKER_SOCKET=/tmp/stewra-docker.sock npm test -w @stewra/provisioner

# c) on the deploy host itself, where the socket is already local
```

**The test image is not arbitrary.** `CapDrop: ALL` denies `CAP_SETUID`, so any image whose
entrypoint drops privilege at runtime (`setpriv`/`su-exec`/`gosu` — the shape of the official redis,
postgres, and nginx images) exits immediately with `setresuid failed`. The suite uses
`nginxinc/nginx-unprivileged:alpine`, which declares its user at build time exactly like
`runner/Dockerfile` does. This is a real constraint on `RUNNER_IMAGE` in production, not a test
detail — see the image-contract note in `provisioner/src/template.ts`.

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

### The skip census — `skip-reporter.mjs`

Registered as a reporter in `playwright.config.ts`. Every run ends with either

```
[skips] none — all 100 tests ran.
```

or every skipped test named, **grouped by reason** so one missing precondition reads as one line
rather than five:

```
[skips] 14/100 tests did not run:
  • no runner paired to this account  (3)
      runner › a paired runner appears in the device list
      …
```

This exists because the run that found the production login outage was 82 passed / 14 skipped / 4
failed, and the fourteen were invisible — `list` prints a dash per skip, thousands of lines up, with
no reason and no total. Eight of them were Today tests skipping on a run that had a database
configured and could have provisioned what they needed.

`E2E_MAX_SKIPS=<n>` turns the census into an assertion: over budget fails the run. Unset means report
only — a default ceiling nobody chose would just get raised the first time it bit.

> The reporter fails the run by returning `{ status: 'failed' }` from `onEnd()`. Setting
> `process.exitCode` there is silently discarded — Playwright computes the exit code from the
> aggregated result *after* reporters finish. Verified, not assumed.

### Provisioned preconditions — `seed.mjs`

Two of the destructive-but-reversible suites need data a fully-triaged account does not have. With
`E2E_DATABASE_URL` set, `seed.mjs` stages **real rows in the real store** and undoes them:

- `openNeedsReplyNudges()` flips a few of A's already-acted-on nudges to `open`, snapshots them, and
  restores the exact prior `(status, snoozed_until)` in `afterAll`.
- `seedNeedsReplyNudges()` covers the case re-opening cannot: an account with **no** acted-on
  `needs_reply` rows. It hangs a correctly-shaped nudge on one of the user's **real** email threads —
  real because `POST /home/suggestions/:id/draft` resolves the option's `threadId` and drafts from the
  thread's actual messages, so a made-up id would fail with "Email thread not found", a red test that
  says nothing about the product.
- `cleanupSeededNudges()` deletes by the `e2e:needs_reply:` dedup-key prefix, **not** by returned ids
  — a run that dies between INSERT and the id landing in the array would otherwise leave a nudge in a
  real user's Today list forever.

When the account has no email thread at all, seeding raises `NoSeedableThreadError` and the Today
tests skip with that as their named, counted reason. Any *other* seeding failure propagates and reds
the run.

> **Known gap:** both QA accounts (`qa-e2e+q2a@`, `qa-e2e+q2b@`) currently have zero connections,
> email_threads, email_messages and suggestions, so the 8 Today action tests have never actually run.
> Fixing it means connecting Gmail for a QA account and running `POST /home/recompute`. Fabricating a
> `connections` row directly would kick off unbounded background sync, so it is deliberately not done
> here.

---

## Post-deploy smoke gate — `website/e2e/smoke/`

A 60-second, **credential-free** check any deploy can be gated on. The full suite takes 13 minutes and
needs two QA accounts; this needs neither, and it is the same assertion that guards the build in CI.

```bash
cd website/e2e

# against a local `vite preview` of a fresh build (what CI runs)
E2E_SMOKE_TARGET=http://127.0.0.1:4173 npm run test:smoke:preview

# against a deployed origin, including the API reachability checks
E2E_SMOKE_TARGET=https://www.stewra.com npm run test:smoke:deployed
```

`E2E_SMOKE_TARGET`, deliberately **not** `E2E_WEB_URL` — `.env.e2e` sets that to production, and a
smoke gate that silently tests production when you meant to test your build is worse than no gate.
Config is `playwright.smoke.config.ts`: one chromium project, `retries: 0`, 30s timeout, JSON into
`.artifacts/smoke.json`.

The specs import `test` straight from `@playwright/test`, never `../fixtures` — the fixture would
trigger `loginAll()` and reintroduce the credential requirement. Shared env loading lives in
`env.mjs`, extracted from `config.mjs` so the credential-validating half is not on this path.

**What it asserts, and why that shape.** A `pageerror` + `console.error` listener is attached *before*
`goto`, and asserted empty *before* any element assertion. That ordering is the whole point: the
production outage was a thrown exception, and asserting only on visible elements reports "heading not
visible" instead of the actual `TypeError: Cannot read properties of null (reading 'useRef')`.
`waitUntil: 'load'` matters too — the module script must have *executed*, not merely parsed.

- `/login` renders logged out, and toggling to "Create account" mounts the Name field and accepts
  typing — that is the `react-hook-form useForm()` path that actually crashed
- `/chats` redirects to `/login`, asserted clean **both** after load and after the redirect resolves
  (`LoginPage` mounts only after the redirect)
- `/runner` renders
- every `/assets/*` referenced by `index.html` returns 200 — catches a half-deployed image pointing at
  a chunk that no longer exists
- deployed-only: `GET /api/health` is `{success:true,data:{status:'ok'}}`, and `POST /api/auth/login`
  with a bogus credential returns 400/401 (a 5xx means the backend behind the origin is not serving)

CI runs the preview form on every push: build the website, start `vite preview` on `127.0.0.1:4173`
with a readiness loop that fails loud, run the gate. This is the step that would have caught the
duplicate-React outage before it shipped — it is a `vite build`-only fault, and CI never built the
website.

---

## Hosted cloud runners, end to end — `runner/smoke-hosted-fullstack.mts`

Joins the two halves that unit and container tests cover separately: can a user **start** a cloud
session through Stewra, and **control** it once it is running?

```bash
BASE=https://www.stewra.com/api \
CLAUDE_CODE_OAUTH_TOKEN=… \
  npx tsx runner/smoke-hosted-fullstack.mts
```

Both variables are required and fail loud when absent; the token is a long-lived headless credential
from `claude setup-token`, which on a deploy lives in `stewra.env` (deliberately uncommitted).
QA credentials come from the repo-root `.env.e2e`.

The arc: log in → assert a GitHub App installation exists → assert hosted mode is enabled → provision
→ wait for the container to dial back with `claude-code` available → **start a Claude Code session**
→ answer its permission prompts → send a follow-up prompt mid-run → assert completion, branch, commit
and `permissionsAnswered > 0` → start a second session and **cancel** it, polling until it leaves
`running` → stop (offline, volumes intact) → start (workspaces survived) → destroy.

It also asserts the laptop invariant against the live system: `GET /runner/hosted/workspaces` and
`POST /runner/git-credentials` with a **local** device token must both be `403`. That is currently
proven only against a scripted backend (`hostedRunnerService.test.ts`).

Safety: it **refuses to adopt or destroy a pre-existing cloud runner**, and its `finally` destroys
only what this run provisioned.

> **Has never been executed.** Production reports `hosted enabled=false` and
> `github-app configured=false`, so the cloud path is not live anywhere. The driver typechecks and
> lints; standing the stack up is the four host prerequisites in `runner/HOSTED.md` plus a real GitHub
> App. **Not covered even then:** the iptables egress fence — see the reboot trade in that document.

---

## Mobile e2e (Maestro) — `frontend/e2e/`

Drives the real app (`com.stewra.app`) on one device/emulator. Flows target the app's **`testID`
contract** (`frontend/e2e/TESTIDS.md`) for interactions and assert on human-readable screen text for
transitions. The single-device call flow is **caller-side smoke only**; genuine two-party
connect/answer and message *delivery* need two devices and have their own runners (below).

**Build Release, not debug.** `flows/login.yaml` starts with `launchApp: clearState: true` so every
run begins signed out. On a debug build that is an Expo **dev client**, and clearing state also wipes
the saved dev-server URL — the app then opens the dev launcher instead of the app, and `assertVisible:
"Sign in"` fails on a perfectly healthy app. A Release build embeds the JS bundle, so it survives
`clearState` and needs no Metro running:

```bash
npx expo run:ios --configuration Release --device <sim-udid>
npx expo run:android --variant release
```

**`brace-expansion` must stay pinned to v2 in the root `overrides`.** v5 replaced the callable
`module.exports = expand` with a named `{ expand }` export, and React Native's codegen still requires
it the old way, so a v5 override makes `pod install` die inside `generate-codegen-artifacts.js` with
`TypeError: expand is not a function` and no iOS build can start. `^2.0.2` is patched for
CVE-2025-5889 and satisfies every consumer in the tree (minimatch 3 through 10). If the pin is ever
changed, note that npm bakes the overridden range into `package-lock.json`: the old version keeps
being re-resolved from the lock until its entry and its rewritten requirement strings are removed.

**Android needs `frontend/google-services.json` before it will even launch.** It is gitignored, so a
fresh clone does not have it, and without it the google-services Gradle plugin is never applied and
the app aborts during its first require chain with `Default FirebaseApp is not initialized in this
process com.stewra.app` (SIGABRT on the JS thread). Every Maestro flow then fails with neither
"Sign in" nor "Chats" visible, which looks like a broken app rather than missing config. Re-fetch it
from the `stewra-260701` Firebase project (the CLI is already authenticated at the account level):

```bash
firebase apps:list --project stewra-260701          # find the ANDROID app id
firebase apps:sdkconfig ANDROID <app-id> --project stewra-260701 \
  -o frontend/google-services.json
```

`frontend/.env` points `GOOGLE_SERVICES_JSON` at it; `app.config.ts` turns that into
`android.googleServicesFile`. **Re-run `npx expo prebuild --platform android` after adding the
file** — the plugin is wired into `android/build.gradle` at prebuild time, so an already-generated
`android/` directory will keep building a crashing APK until you do.

**On this machine, the Android build must write its output to APFS.** The checkout lives on
`/Volumes/charan`, which mounts as exFAT through macOS's fskit driver:

```
/dev/disk4s3 on /Volumes/charan (exfat, local, nodev, nosuid, noowners, noatime, fskit)
```

fskit does not reliably serve a read that immediately follows a write to the same file, and an
Android build does that constantly (R.jar, merged manifests, extracted AARs). The symptom is a build
that dies on a corrupt archive or a missing entry in a file that plainly exists, naming a *different*
file on each retry — that randomness is the tell that it is the filesystem, not the build graph.

The NDK link step fails with a second, more confusing signature:

```
ld.lld: error: .../obj/arm64-v8a/libreact_codegen_safeareacontext.so: unknown file type
```

The named `.so` is there and is the right size — it is **entirely null bytes**. `ld.lld` writes its
output through `mmap`, and fskit never flushes those pages, so a link that reports success leaves a
zero-filled file behind. It is not a stale artifact: deleting it and relinking produces another
zeroed file, and the failure walks to a different library and a different ABI on each retry. A plain
`cp` of the same bytes onto the same volume comes back byte-identical, which is what rules the
toolchain out. Confirm with:

```bash
LC_ALL=C tr -d '\0' < path/to/lib.so | wc -c   # 0 means the file is all zeros
```

The redirect below is the fix here too — it moves the whole `.cxx`/`intermediates` tree onto APFS.

`frontend/gradle/redirect-builddir.gradle` is an init script that moves every subproject's build
directory onto APFS. It deliberately leaves the **root** project alone (expo-modules-autolinking
writes `autolinking.json` under the root build dir and `:app` reads it back during configuration), and
it **throws if `STEWRA_BUILD_DIR` is unset** rather than guessing a path back onto exFAT:

```bash
cd frontend/android
STEWRA_BUILD_DIR="$HOME/.stewra-build" \
  ./gradlew -I ../gradle/redirect-builddir.gradle assembleRelease
```

It lives in `frontend/gradle/`, not `frontend/android/`, because `expo prebuild` regenerates
`frontend/android/` wholesale.

**Use dedicated devices.** Other projects on this machine boot their own simulators/emulators, and
Maestro picks a target non-deterministically when several are attached. Create devices that are
obviously Stewra's and pin them explicitly:

```bash
xcrun simctl create "Stewra-iPhone17" "iPhone 17 Pro" com.apple.CoreSimulator.SimRuntime.iOS-26-3
avdmanager create avd -n Stewra_Pixel -k "system-images;android-35;google_apis_playstore;arm64-v8a" -d pixel_9
```

```bash
# Prereqs: Maestro CLI, a Release build installed, adb (Android) / xcrun (iOS).
# Fill the repo-root .env.e2e (same file as the web suite).

frontend/e2e/run-all-features.sh android                       # login → send → call smoke → logout → full
frontend/e2e/run-all-features.sh ios <sim-udid>                # same flows on a booted simulator
frontend/e2e/run-features.sh flows/send-message.yaml android   # a single flow (pins the device)
frontend/e2e/scripts/reset-devices.sh                          # adb pm clear on every attached device (sign out)
```

### Two-party (two devices, two users)

Maestro drives one device per invocation, so anything needing both users at once is orchestrated by a
wrapper. Devices are given as `<platform>:<id>` (a bare value means an adb serial):

```bash
frontend/e2e/run-two-party-message.sh ios:<sim-udid> android:emulator-5554   # A→B and B→A delivery
frontend/e2e/run-two-party-call.sh voice ios:<sim-udid> android:emulator-5554
frontend/e2e/run-two-party-call.sh video ios:<sim-udid> android:emulator-5554
```

Messaging works in both roles on both platforms. **Calls require the callee to be Android**: an
incoming call is raised by the *native* ringer (CallKit on iOS, Core-Telecom on Android), not an
in-app screen, so there is no `Answer` testID. On Android the ringer is a system notification that
`adb shell input tap` can hit at coordinates read from the SystemUI hierarchy; on iOS the CallKit UI
lives outside the app process and `simctl` has no input-tap. So iOS may *place* a call but not answer
one — the script rejects an iOS callee up front with that reason.

Two non-obvious things about reading that Android notification, both of which cost a full debugging
session and are worth not rediscovering:

- **`maestro hierarchy` cannot see it.** Maestro's Android hierarchy is scoped to the app under test,
  so `com.android.systemui` is simply absent. The runner uses `adb shell uiautomator dump` instead.
- **The shade has to be expanded first.** A heads-up notification does not take window focus and is
  not in the dumpable window set — `uiautomator` returns the app's window and nothing else, so the
  Answer button is invisible to automation *while being plainly visible on a screenshot*. After
  `adb shell cmd statusbar expand-notifications` the same notification, with the same actions,
  lands in a window `uiautomator` can read:

  ```xml
  <node text="⁦📞 ⁨Answer⁩⁩" resource-id="android:id/action0" class="android.widget.Button"
        package="com.android.systemui" content-desc="Answer" clickable="true"
        bounds="[540,800][1006,926]" />
  ```

  Match on `content-desc` — the `text` is bidi-isolate-wrapped and emoji-prefixed. Answer and Decline
  share `resource-id=android:id/action0`, so the label is the only discriminator.

Because the runner opens the shade, it also collapses it — both after answering and defensively at
startup. A run that dies in between otherwise leaves the shade covering the screen, and the *next*
run fails at login with "Sign in is not visible", which reads as a login bug rather than stale state.

**iOS raises a "Save Password?" system alert** after a successful credential submit. It belongs to
another process, but Maestro's iOS hierarchy does expose it (`accessibilityText: "Not Now"`, with
bounds), so `flows/login.yaml` dismisses it with an optional `tapOn`. Left up it covers the app and
the "Chats" wait times out even though sign-in succeeded. Suppressing it at the source does **not**
work — `simctl spawn <udid> defaults write com.apple.Preferences AutoFillPasswords -bool false`
leaves the alert appearing anyway.

`testID` is a plain prop change — but on a Release build it takes a rebuild, not a hot reload.

### What a simulator/emulator cannot cover — manual checklist

The automated matrix above runs on the iOS simulator and the Android emulator. These cases are
**not** reachable there and have to be checked by hand on a real handset:

| Case | Why the simulator can't | How to check |
| --- | --- | --- |
| Answering an incoming call on iOS | CallKit's incoming-call UI is a separate system process. Maestro's hierarchy can't see it and `simctl` has no input-tap. | Place a call from the Android emulator to the iPhone; answer from the CallKit screen (including from the lock screen) and confirm audio both ways. |
| *Placing* a call from iOS | The simulator ships neither FaceTime nor Phone, so `callservicesd` cannot open `facetime://?showInCallUI=1` to host a third-party call's UI. It fulfils `CXStartCallAction` and then disconnects the call ~1 s later ("Disconnecting call because there wont be a UI to host the call", disconnect reason 55). The callee rings, the caller is already gone, and no offer is ever sent. See below. | Place a call from the iPhone to the Android emulator and assert both ends connect. |
| Real camera capture in a video call | The iOS simulator has no camera at all; the Android emulator serves a synthetic scene, so "the remote side sees me" is never really proven. | Video-call between the phone and the emulator; confirm a live camera image at both ends, then that `call-stop-video` blanks only the local feed. |
| Real microphone / speaker routing | Simulators route through the host audio device. Speakerphone, earpiece, and the `call-speaker` toggle have no real effect. | On the call above, toggle `call-speaker` and confirm the output device actually changes; plug in headphones mid-call and confirm it follows. |
| Push-woken incoming calls (app killed) | Needs real APNs/FCM delivery to a registered device token. | Force-quit the app on the phone, call it from the emulator, confirm it rings. |
| Background/locked-screen call delivery | Simulator background execution and screen lock don't match device behaviour. | Lock the phone, call it, confirm the call arrives and survives unlock. |

**Neither call direction is reachable on the iOS simulator**, so an iOS-to-anything call is
device-only coverage. The outgoing half was diagnosed on 2026-07-31 from the simulator's own log
(`xcrun simctl spawn <udid> log show --predicate 'subsystem == "com.apple.calls.callservicesd"'`):

```
17:40:42.264  Start call action fulfilled: <CXStartCallAction … callUUID=4969A37E-…>
17:40:42.303  TUOpenURLWithCompletion result: (null), error: LSApplicationWorkspaceErrorDomain:115
17:40:42.304  Encountered error while opening URL: facetime://?showInCallUI=1
17:40:42.304  Disconnecting call because there wont be a UI to host the call
17:40:42.310  Set failure reason CXCallFailureReasonGenericError, disconnect reason: 55
17:40:42.317  End call action fulfilled
```

`xcrun simctl listapps` confirms the simulator has no `com.apple.facetime` and no
`com.apple.mobilephone`, so that URL can never open. The app behaves correctly throughout — it
places the call, the callee rings — and is then told by the OS that its call has ended. Android is
unaffected (Core-Telecom hosts the UI in-process) and all four web↔Android combinations connect.

**Blocked right now — needs an Xcode upgrade.** The attached iPhone 13
(hardware UDID `00008110-001E483434D9401E`, CoreDevice `CE506FB7-5F70-5F80-8D44-3DB0D247669D`) is
connected over USB with Developer Mode enabled, but **no on-device test of any kind can run on it**:

```
$ xcrun devicectl device info details --device 00008110-001E483434D9401E
Error: The developer disk image could not be mounted on this device.
  • ddiServicesAvailable: false
  • developerModeStatus: enabled
  • osVersionNumber: 26.5.2
```

The phone runs **iOS 26.5.2**; the only Xcode installed is **26.3 (17C529), which ships the iOS 26.2
SDK** and a DDI of the same build. A DDI older than the device OS will not mount, and without DDI
services the device exposes no XCTest, no debugserver, and no app-install path. That blocks *every*
route at once — `xcodebuild test`, Maestro, and Appium/WebDriverAgent alike, since WDA is itself an
XCTest bundle. **Fix: install Xcode ≥ 26.5 (Apple ID download + admin install — the account owner's
action).** Nothing in this repo can work around it.

Two things that are *not* the blocker, recorded so they don't get re-litigated:

- **Appium can drive a physical iPhone even though Maestro can't.** Maestro is simulator-only
  (`maestro list-devices` never lists a wired iPhone), but the sibling Truetalk project automates the
  *same* handset with Appium 3 + the XCUITest driver — see
  `/Volumes/charan/projects/AI/product_advisor/frontend/e2e/appium/`. Appium 3.6.0 and
  `xcuitest@12.1.2` are installed on this machine and ready. Porting it here is real work (Stewra has
  no in-app answer UI, so Truetalk's `incoming-call-accept` flow does not carry over — the CallKit
  answer path would have to be proven empirically), but it is not blocked in principle.
- **Signing is not the obstacle.** `~/Library/Developer/Xcode/UserData/Provisioning Profiles/`
  carries a wildcard **`iOS Team Provisioning Profile: *`** (team `35JR7LFXPF`, valid to 2027-05-12)
  whose `ProvisionedDevices` already includes this iPhone's UDID, and a matching *Apple Development:
  Robin Singh* identity is in the keychain. That wildcard carries no `aps-environment`, so
  `frontend/ios/Stewra/Stewra.entitlements` (which requests `aps-environment: development`) still
  needs a real App ID for `com.stewra.app` — but `-allowProvisioningUpdates` creates that
  automatically, exactly as Truetalk's caps rely on. Revisit once the DDI mounts.

Android has no equivalent gap today because no physical Android handset is attached — `adb devices`
lists only `emulator-5554`. Plugging one in makes it a drop-in for either role in both two-party
wrappers (`android:<serial>`), including the callee role that iOS can't take.

---

## Deliberately out of scope (vs. Truetalk)

Truetalk also ships an **IMAP-OTP account-bootstrap** harness (to create accounts by reading
email/SMS one-time codes). Stewra skips it on purpose: we use pre-verified QA accounts with password
login, so it doesn't earn its complexity here. Revisit only if we need to create accounts from
scratch in the suite.

Truetalk's **Appium/WebDriverAgent** harness is a different case — it is *wanted* here, not declined.
It is the only way to automate the physical iPhone (Maestro is simulator-only), and it is what would
finally cover the manual checklist above. It is not ported yet because the DDI blocker above makes
any on-device run impossible today; see that section for what is and isn't in the way.

## What CI runs, and what it does not

`.github/workflows/ci.yml` runs, on every push:

- `typecheck`, `lint`, `boundaries`
- Vitest: backend, bridge, runner, **and provisioner** (with `DOCKER_SOCKET=/var/run/docker.sock` set
  explicitly, so the runner's socket vanishing is a failure rather than a silent skip of all 14 tests)
- **build the website**, then the smoke gate against a `vite preview` of that build

Everything else is **run locally, one command each**:

- the full Playwright suite — it needs the two QA accounts and targets production
- Maestro — needs a device
- `runner/smoke-*-fullstack.mts` — need a live backend, and the hosted one needs the cloud stack

The website build + smoke steps exist because of a specific incident: a duplicate-React bundle made
`stewra.com` a blank screen for every logged-out visitor, and nothing upstream could see it. It is a
`vite build`-only fault (`vite dev` dedupes through esbuild), CI never built the website, and the only
spec that visits a page logged out is the one that caught it — every other spec is seeded with
`storageState` and never renders `LoginPage`. A type error cannot see a bundler-level module
duplication.
