# Frontend (React Native) E2E suite

End-to-end flows that drive the **real Stewra app** on a device or emulator with
[Maestro](https://maestro.mobile.dev/). They cover the core journey — sign in, send
a message, place a call, sign out — plus an adb utility for resetting devices between
runs.

This is the mobile counterpart to [`website/e2e/`](../../website/e2e/). The website
suite drives two browser sessions at once (good for two-party calls); Maestro drives
one device, so the call flow here is a **caller-side smoke test** only.

## Prerequisites

- **Maestro CLI** — `curl -Ls "https://get.maestro.mobile.dev" | bash`
- **A build of the app installed** on the target (`com.stewra.app`) — e.g.
  `npx expo run:android`, or a dev/release APK installed on a real phone.
- **adb** on PATH (Android platform-tools) for `scripts/reset-devices.sh`.
- One attached device or emulator: `adb devices -l` should list it.

## Credentials (never hardcoded)

Flows take credentials via Maestro `--env`; nothing is baked in. Copy the example
and fill it with an **email-verified** test user:

```bash
cp e2e.env.example e2e.env      # e2e.env is gitignored
# edit e2e.env
set -a; source e2e.env; set +a
```

## Run

```bash
# Full journey: login → send message → voice-call smoke → logout
maestro test \
  --env EMAIL="$EMAIL" --env PASSWORD="$PASSWORD" \
  --env CONTACT_NAME="$CONTACT_NAME" \
  flows/full.yaml

# Or a single step:
maestro test --env EMAIL="$EMAIL" --env PASSWORD="$PASSWORD" flows/login.yaml
maestro test --env CONTACT_NAME="$CONTACT_NAME" flows/send-message.yaml
maestro test flows/logout.yaml
```

`CONTACT_NAME` picks which thread to open; leave it blank to use the first
conversation in the list.

## Flows

| File | What it checks |
| --- | --- |
| `flows/login.yaml` | Sign in with env creds; lands on the Chats tab (token valid + verified). |
| `flows/send-message.yaml` | Open a thread, type into the composer, Send; the bubble echoes the text. |
| `flows/call-smoke.yaml` | Tap **Start voice call**; the call screen appears and **End call** ends it. Caller side only — see below. |
| `flows/logout.yaml` | Tap the header **Log out**; app returns to **Sign in** (guards the logout hardening). |
| `flows/full.yaml` | Runs all four in order. |

### Why the call test is caller-side only

WebRTC calls need a live callee. A real connect/answer assertion requires a second
signed-in session, which Maestro (one device) can't provide. The two-party audio and
video connect tests live in `website/e2e/calls.audio.mjs` / `calls.video.mjs`, which
seed two browser contexts and drive both ends. Here we assert only that the outgoing
call UI launches and can be ended cleanly.

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
