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
- **A build of the app installed** on the target (`com.stewra.app`) — e.g.
  `npx expo run:android`, or a dev/release APK installed on a real phone.
- **adb** on PATH (Android platform-tools), or **Xcode command line tools** (`xcrun`)
  for iOS simulators.
- One attached device or emulator/simulator: `adb devices -l` (android) or
  `xcrun simctl list devices booted` (ios) should list it.

## Credentials (never hardcoded)

This suite shares **one** untracked secrets file at the **repo root** with the
Playwright web suite — `../../.env.e2e` (there is no separate `frontend/e2e` copy):

```bash
cp ../../.env.e2e.example ../../.env.e2e     # .env.e2e is gitignored at the repo root
# edit ../../.env.e2e — fill E2E_USER_A_EMAIL / E2E_USER_A_PASSWORD / E2E_CONTACT_NAME
```

The run wrappers below source it automatically (`set -a; source ../../.env.e2e; set +a`)
and fail loudly if the file is missing or required keys are blank — nothing falls
back to a hardcoded default.

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
| `flows/logout.yaml` | Tap the header **Log out**; app returns to **Sign in** (guards the logout hardening). |
| `flows/full.yaml` | Runs all four in order. |

### Why the call *flow* is caller-side only

WebRTC calls need a live callee. A real connect/answer assertion requires a second
signed-in session, which a single Maestro flow (one device) can't provide. So
`flows/call-smoke.yaml` asserts only that the outgoing call UI launches and can be
ended cleanly. Two-party parity on the web side lives in
`website/e2e/tests/calls.spec.ts` (two browser contexts, both ends assert `Connected`).

## Two-party device-to-device call

`run-two-party-call.sh` drives a **real** two-party WebRTC call across **two attached
Android devices**: device A places the call (signed in as QA user A), device B answers
it (signed in as QA user B), both ends are asserted to reach the connected state, then
A hangs up and both are asserted to leave the call. This is the durable form of the
orchestration proven live on 2026-07-19 (emulator ↔ USB Pixel 8, voice and video).

```bash
# <voice|video> <caller-serial> <callee-serial> [--no-login]
./run-two-party-call.sh voice emulator-5554 <phone-serial>
./run-two-party-call.sh video emulator-5554 <phone-serial>
./run-two-party-call.sh voice emulator-5554 <phone-serial> --no-login   # skip sign-in
```

Both serials are **explicit** (see `adb devices -l`) — there's no sane default for
"which device is the caller", and pinning avoids Maestro's non-deterministic device
pick. It sources the same `.env.e2e` and additionally needs `E2E_USER_B_EMAIL` /
`E2E_USER_B_PASSWORD` and `E2E_CONTACT_NAME` (B's display name as it appears in A's
chat list).

A single Maestro flow can't answer the call, because callkit-telecom raises the
incoming call as a **system heads-up notification** (not a React view): its "Answer"
button has no `testID`, its visible text is bidi-wrapped, and a cold `maestro test` is
too slow to catch it before the ring times out. The script instead reads the live view
hierarchy (which cleanly exposes `accessibilityText: "Answer"` with pixel bounds) and
`adb ... input tap`s the button centre directly.

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
