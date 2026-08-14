# Frontend (React Native) E2E suite

End-to-end flows that drive the **real Stewra app** on a device or emulator with
[Maestro](https://maestro.mobile.dev/). They cover the core journey — sign in, send
a message, place a call, sign out — plus an adb utility for resetting devices between
runs.

This is the mobile counterpart to [`website/e2e/`](../../website/e2e/). The website
suite drives two browser sessions at once (good for two-party calls); a single Maestro
flow drives one device, so the call *flow* here (`flows/call-smoke.yaml`) is a
**caller-side smoke test** only. For a **real device-to-device call** there is a
separate orchestrator, [`run-two-party-call.sh`](#two-party-device-to-device-call),
which coordinates two devices with Maestro + adb.

Element selectors are **registered `testID`s**, not visible text or
`accessibilityLabel` — see [`TESTIDS.md`](./TESTIDS.md) for the full contract between
the app and this suite. `assertVisible` still checks human-readable screen text (e.g.
"Chats", "Sign in", the echoed message body) for transition assertions, since those
prove real navigation and real data round-tripping.

## Prerequisites

- **Maestro CLI** — `curl -Ls "https://get.maestro.mobile.dev" | bash`
- **A _Release_ build of the app installed** on the target (`com.stewra.app`):
  `npx expo run:android --variant release`, or
  `npx expo run:ios --configuration Release --device <sim-udid>`.
  Release matters: `flows/login.yaml` opens with `launchApp: clearState: true` so each run
  starts signed out, but a **debug** build is an Expo *dev client* — clearing its state also
  wipes the saved dev-server URL, so the app comes up on the dev launcher and
  `assertVisible: "Sign in"` fails on a completely healthy app. A Release build embeds the
  JS bundle, survives `clearState`, and needs no Metro running. The trade-off: a `testID`
  change needs a rebuild instead of a hot reload.
- **Devices that belong to this project.** Other projects on the same machine boot their own
  simulators/emulators, and Maestro picks non-deterministically among whatever is attached.
  Create clearly-named ones and pin them:
  ```bash
  xcrun simctl create "Stewra-iPhone17" "iPhone 17 Pro" com.apple.CoreSimulator.SimRuntime.iOS-26-3
  avdmanager create avd -n Stewra_Pixel \
    -k "system-images;android-35;google_apis_playstore;arm64-v8a" -d pixel_9
  ```
- **adb** on PATH (Android platform-tools), or **Xcode command line tools** (`xcrun`)
  for iOS simulators.
- One attached device or emulator/simulator: `adb devices -l` (android) or
  `xcrun simctl list devices booted` (ios) should list it.

## iOS differences the flows absorb

Three things behave differently enough on iOS to have broken the whole suite there. All three are
handled in the flows; they're recorded here so the next flow doesn't re-introduce them.

1. **`clearState` doesn't sign you out on iOS.** It wipes the app container but not the Keychain,
   and `expo-secure-store` keeps the session token there — so the app relaunches straight into
   Chats. Android's `pm clear` really does drop everything. `flows/login.yaml` therefore treats
   "already signed in" as an expected start state and signs out first.
2. **iOS composes accessibility labels; Maestro text selectors are whole-string regexes.** See
   [`TESTIDS.md`](./TESTIDS.md) — short version: wrap partial text in `.*`.
3. **`pressKey: Back` is a no-op on iOS** (no hardware back key). `flows/lib/goto-chats.yaml`
   relaunches the app instead, which resets the navigator on both platforms.

## Credentials (never hardcoded)

This suite shares **one** untracked secrets file at the **repo root** with the
Playwright web suite — `../../.env.e2e` (there is no separate `frontend/e2e` copy):

```bash
cp ../../.env.e2e.example ../../.env.e2e     # .env.e2e is gitignored at the repo root
# edit ../../.env.e2e — fill E2E_USER_A_EMAIL / E2E_USER_A_PASSWORD / E2E_CONTACT_NAME
```

The run wrappers below load it automatically via [`lib/load-env.sh`](./lib/load-env.sh)
and fail loudly if the file is missing or required keys are blank — nothing falls
back to a hardcoded default.

`load-env.sh` **parses** the file rather than `source`-ing it. `.env.e2e` is a dotenv
file shared verbatim with the web suite, and shell `source` *executes* it: an unquoted
value containing spaces — e.g. `E2E_CONTACT_NAME=QA Web B`, which dotenv reads correctly
as `QA Web B` — becomes an assignment plus a stray command, and the wrapper died with
`.env.e2e: line 9: Web: command not found` before reaching the flow. Parsing also stops a
stray line in a secrets file from running arbitrary code. Real environment variables win
over the file, matching the web suite, so CI can inject the same names with no file.

## Run

```bash
# Every flow in flows/, in sequence, with a PASS/FAIL summary:
./run-all-features.sh android
./run-all-features.sh ios
./run-all-features.sh android <device-serial>   # pin an explicit device

# A single flow:
./run-features.sh flows/login.yaml android
./run-features.sh flows/send-message.yaml android
./run-features.sh flows/call-smoke.yaml android
./run-features.sh flows/logout.yaml android
./run-features.sh flows/full.yaml android        # login → send → call smoke → logout
```

Both wrappers **pin the device explicitly** before invoking Maestro — a documented
gotcha is that a bare `maestro test` picks a device non-deterministically when a
simulator/emulator is also booted alongside a physical device. For android they
resolve the single attached device via `adb devices`; for ios, the single booted
simulator via `xcrun simctl list devices booted`. Pass a UDID/serial as the last
argument to skip auto-resolution (required when more than one device is present).

`E2E_CONTACT_NAME` (from `.env.e2e`) picks which thread to open; leave it blank to
use the first conversation in the list.

## Flows

| File | What it checks |
| --- | --- |
| `flows/login.yaml` | Sign in with env creds; lands on the Chats tab (token valid + verified). |
| `flows/send-message.yaml` | Open a thread, type into the composer, Send; the bubble echoes the text. |
| `flows/call-smoke.yaml` | Tap **Start voice call**; the call screen appears and **End call** ends it. Caller side only — see below. |
| `flows/today.yaml` | Open the Today tab, tap **Refresh**; a briefing card appears (server-side sync + rebuild ran). |
| `flows/activity.yaml` | Settings → Activity; at least one feed row renders (today's recompute guarantees one). |
| `flows/connections.yaml` | Settings shows the QA user's connected Google account and the connect button (not tapped — OAuth lives in the browser, covered by the web suite). |
| `flows/pause.yaml` | Toggle **Pause Stewra** on, relaunch, assert the switch re-reads checked from the server; toggle off and assert the resume persisted the same way. |
| `flows/logout.yaml` | Tap the header **Log out**; app returns to **Sign in** (guards the logout hardening). |
| `flows/full.yaml` | Runs all four in order. |
| `flows/optional/runner-session.yaml` | Opt-in — the in-chat "Run coding agent" card. See below. |
| `flows/two-party/receive-message.yaml` | Receiving half of the two-party message test — a message from the *other* user's device arrives live. Driven by `run-two-party-message.sh`; can't pass standalone. |
| `flows/lib/goto-chats.yaml` | Shared subflow — get back to the Chats tab root from wherever the previous flow ended. Asserts nothing on its own. |
| `flows/lib/open-thread.yaml` | Shared subflow — `goto-chats` then open `CONTACT_NAME`'s thread (or the top one when blank). |

Subflows live under `flows/lib/` (and `flows/two-party/`, `flows/optional/`) so the depth-1 sweep in
`run-all-features.sh` doesn't try to run them as standalone tests.

`run-all-features.sh` runs the top-level flows in **dependency order**
(`login → send-message → call-smoke → logout → full`), not alphabetically. Only `login.yaml`
starts from a cleared state; the rest assume a signed-in session and `logout.yaml` ends signed
out, so a plain alphabetical sweep ran `call-smoke` before any sign-in and `send-message` after
logout. `full.yaml` goes last because it re-runs the journey from a cleared state. A flow added
to `flows/` but not listed in `ORDER` is appended last with a warning rather than silently
skipped.

### Opt-in: runner coding-agent session

`flows/optional/runner-session.yaml` asks Stewra (in the pinned **Stewra** thread) to run a coding
agent on one of your machines, waits for the proposal card, taps **Start**, and asserts the session
begins. It needs a runner **paired and online** (`npx @stewra/runner pair <code>`) plus
`E2E_RUNNER_MACHINE` / `E2E_RUNNER_WORKSPACE` / `E2E_RUNNER_HARNESS` in the shared `../../.env.e2e`.

It lives under `flows/optional/` so `run-all-features.sh` (a depth-1 sweep) does **not** pick it up:
Maestro has no `test.skip`, so a flow that requires a live runner can't gracefully no-op like the web
`runner.spec.ts` does. Run it explicitly when the precondition holds:

```bash
./run-features.sh flows/optional/runner-session.yaml android
```

The web twin is `website/e2e/tests/runner.spec.ts` (auto-discovers the runner, skips if none online).

### Why the call *flow* is caller-side only

WebRTC calls need a live callee. A real connect/answer assertion requires a second
signed-in session, which a single Maestro flow (one device) can't provide. So
`flows/call-smoke.yaml` asserts only that the outgoing call UI launches and can be
ended cleanly. Two-party parity on the web side lives in
`website/e2e/tests/calls.spec.ts` (two browser contexts, both ends assert `Connected`).

## Two-party (two devices, two users)

Maestro drives one device per invocation, so anything that needs both users live at once is
orchestrated from outside Maestro by a wrapper. Both wrappers take devices as
`<platform>:<id>`, or a bare value meaning an adb serial:

| spec | means |
| --- | --- |
| `android:emulator-5554` | adb serial (`adb devices -l`) |
| `ios:<UDID>` | booted simulator (`xcrun simctl list devices booted`) |
| `emulator-5554` | bare = Android, so the original serial-only invocations still work |

Devices are always **explicit** — there's no sane default for "which device is the caller",
and pinning avoids Maestro's non-deterministic device pick.

### Messaging delivery (both directions, any platform pairing)

`run-two-party-message.sh` sends a nonced message from device A, asserts device B **receives**
it live, then replies from B and asserts A receives that. Both directions must pass.

```bash
# <device-a> <device-b> [--no-login]
./run-two-party-message.sh ios:<sim-udid> android:emulator-5554
./run-two-party-message.sh android:emulator-5554 ios:<sim-udid> --no-login
```

Why it exists next to `flows/send-message.yaml`: that flow only asserts the sender's *own*
bubble echoes its text, which a purely optimistic local render satisfies without the message
ever reaching the backend. Delivery is only observable on the other user's device.
`flows/two-party/receive-message.yaml` is the receiving half; it lives outside the depth-1
`flows/` sweep because it can't pass standalone (it needs the matching send).

This one is fully cross-platform in **both** roles — receiving a message is ordinary in-app UI
that Maestro sees on iOS and Android alike.

### Device-to-device call

`run-two-party-call.sh` drives a **real** two-party WebRTC call: the caller places it (signed
in as QA user A), the callee answers (QA user B), both ends are asserted to reach the connected
state, then the caller hangs up and both are asserted to leave the call. This is the durable
form of the orchestration proven live on 2026-07-19 (emulator ↔ USB Pixel 8, voice and video).

```bash
# <voice|video> <caller-device> <callee-device> [--no-login]
./run-two-party-call.sh voice ios:<sim-udid> android:emulator-5554
./run-two-party-call.sh video emulator-5554 <phone-serial>
./run-two-party-call.sh voice emulator-5554 <phone-serial> --no-login   # skip sign-in
```

**The callee must be Android.** Answering is the asymmetry: an incoming call is raised by the
*native* ringer (CallKit on iOS, Core-Telecom on Android), not an in-app React screen, so there
is no `Answer` testID on either platform. On Android the ringer is a system notification that
`adb shell input tap` can hit at coordinates read from the live hierarchy. On iOS the CallKit UI
lives outside the app process — Maestro's hierarchy can't see it and `simctl` has no input-tap
equivalent — so an iOS callee is rejected up front with that reason instead of hanging for 45s.

**On a simulator the iOS *caller* does not work either** — the app is fine, CallKit refuses to keep
the call. Measured on `Stewra-iPhone17` (iOS 26.3) on 2026-07-31: `CXStartCallAction` is fulfilled,
then ~40 ms later `callservicesd` tries to raise the system in-call UI and dies on it —

```
Encountered error while opening URL: facetime://?showInCallUI=1   (LSApplicationWorkspaceErrorDomain:115)
Disconnecting call because there wont be a UI to host the call
Set failure reason CXCallFailureReasonGenericError, disconnect reason: 55
```

A simulator ships **neither FaceTime nor Phone**, so the URL that hosts a third-party call's UI can
never open, and every outgoing CallKit call is disconnected about a second after it starts. The
callee still rings (our signalling reached the server before CallKit gave up), but the caller has
already torn down and never sends its SDP offer, so nothing connects. Nothing in app code can avoid
this; a real handset is the only way to cover an iOS-originated call.

Both wrappers load the same `.env.e2e` and additionally need `E2E_USER_B_EMAIL` /
`E2E_USER_B_PASSWORD`. `E2E_CONTACT_NAME` (B's display name in A's chat list) and
`E2E_CONTACT_NAME_A` (A's name in B's list) select which thread to open; blank means the top
thread, which is where a message just sent lands.

A single Maestro flow can't answer the call, because callkit-telecom raises the
incoming call as a **system heads-up notification** (not a React view): its "Answer"
button has no `testID`, its visible text is bidi-wrapped, and a cold `maestro test` is
too slow to catch it before the ring times out. The script instead reads the live view
hierarchy (which cleanly exposes `accessibilityText: "Answer"` with pixel bounds) and
`adb ... input tap`s the button centre directly.

**Ending a call from the OS, on Android.** The Core-Telecom call the app places is *self-managed*,
and `TelecomManager.endCall()` refuses to end those — so `adb shell input keyevent KEYCODE_ENDCALL`
never touches the call. Worse, it does not fail: `PhoneWindowManager` falls through to its no-call
behaviour and puts the display to **sleep**, after which every later Maestro step fails on a black
screen with an unrelated-looking `"Chats" is visible` assertion error. A self-managed call also has
no system in-call screen; its native UI is the ongoing-call notification on the
`expo_callkit_telecom_ongoing` channel, whose single action is **"Hang Up"**. Expand the shade,
read the bounds out of `uiautomator dump`, and tap that — it is the same code path a user takes,
and it reaches the app with `appInitiatedEnd` clear.

Verified on `Stewra_Pixel` on 2026-07-31: with the emulator as caller and the web client as an
unanswered callee, tapping "Hang Up" cleared the callee's ring in **184 ms** (8.4 s into a ring
whose server-side timeout is 60 s, so the timeout is not what cleared it). That is the regression
guard for the caller-side end: the caller must emit `call:end`, because the backend answers a
`call:decline` from the *caller* with `invalid_call` and no event, which leaves the callee ringing.

**The emulator's screen timeout will bite you.** Any run longer than the default sleeps the display
mid-flow. Set it once per boot: `adb -s <serial> shell settings put system screen_off_timeout 1800000`.

For **voice**, connectedness is asserted by the `Connected` status label on both ends.
For **video**, once media flows that label is replaced by the remote video surface
(which has no `testID`), so the script asserts the in-call screen persists past the
ringing labels; the pixel-level "I can see their camera" remains a manual visual check.

## Resetting devices between runs

WebRTC calls fan out to **every** device a user is signed in on. A phone still logged
in as a test user will answer an incoming call and break a browser-to-browser
handshake — so sign the mobile devices out before running the website call suite:

```bash
./scripts/reset-devices.sh            # clear app data on every attached device
./scripts/reset-devices.sh <serial>   # just one (from: adb devices -l)
APP_ID=com.other.app ./scripts/reset-devices.sh   # override the package
```

It runs `adb shell pm clear com.stewra.app`, which wipes expo-secure-store so the next
launch is signed out.
