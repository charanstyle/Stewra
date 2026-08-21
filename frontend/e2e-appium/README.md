# Frontend E2E — Appium + Vitest

Drives the **real Stewra app on real phones over Wi-Fi**. No cables, no simulators, no mocks.

This replaces the Maestro suite in [`../e2e/`](../e2e/), which stays in place until this one
reaches flow parity. The reason for the switch is device connectivity: Maestro reaches a physical
iPhone only through a cable, while Appium's `xcuitest` driver creates the iOS 17+ tunnel itself
(`appium driver run xcuitest tunnel-creation`), so an iPhone that is merely on the same Wi-Fi is
drivable.

## Prerequisites

- **Appium 3** with both drivers:
  ```bash
  appium driver install uiautomator2     # Android
  appium driver install xcuitest         # iOS
  ```
- **A _Release_ build installed** on each phone (`com.stewra.app`). Release matters for the same
  reason it did under Maestro: a debug build is an Expo dev client, so clearing its state also
  wipes the saved dev-server URL and the app comes up on the dev launcher.
- **`adb` on PATH** (Android platform-tools) and **Xcode command line tools** for iOS.
- The shared secrets file at the repo root — `../../.env.e2e`. Parsed, never sourced; see
  [`lib/env.ts`](./lib/env.ts). Missing keys fail the run immediately, before any device is driven.

## Getting the phones on Wi-Fi

**Android** — one-time per phone, over a cable, then the cable is never needed again:

```bash
adb -s <usb-serial> tcpip 5555          # fixed port; survives until the phone reboots
adb connect <phone-ip>:5555
```

Prefer a **static DHCP reservation** for each handset. Android and iOS randomise their MAC *per
SSID*, so reserve the per-SSID MAC, and note that "forget network" earns a new one.

`adb tcpip` is used rather than the Wireless-debugging pairing flow because that flow's port
rotates on every toggle and the toggle does not survive a reboot; port 5555 is stable and needs no
pairing code. Wireless debugging still works if you prefer it — pair once, then find the port with
`adb mdns services`.

**iOS** — tick **"Connect via network"** for the phone in **Xcode → Window → Devices and
Simulators**, once, with the cable in. Appium finds iPhones through **usbmuxd**, and usbmuxd only
carries a device over the network after that checkbox; without it the phone is USB-only no matter
how reachable it is by IP. Verify with:

```bash
npm run e2e:devices
```

> **A cable actively breaks the wireless path.** While an iPhone is plugged in, iOS advertises the
> developer service *only* over the USB link and stops advertising it on Wi-Fi — so a half-working
> cable gives you neither transport. If a phone has gone missing, unplug it first.

## Run

```bash
npm run appium          # terminal 1 — the server, on :4723
npm run e2e             # terminal 2 — every test, on every attached device
npm run e2e:devices     # what would it run against right now?
```

`npm run e2e` discovers devices at collection time and runs each test file against **all** of
them, so one invocation covers every attached handset. There is no device list to maintain: a
phone that is attached is tested, and a phone that is not is not silently skipped — with zero
devices the run fails, naming what to check.

A phone that is plugged in *and* has a wireless target appears twice under two serials. The
wireless entry wins (a cable is transient, the reserved address is not) and the collapse is logged.

## When something fails

Every test writes a screenshot and the full element hierarchy to `artifacts/` on failure, named
for the device and test. That directory is gitignored — the images picture a signed-in QA
account's real screen.

This is the difference between "testID X never became visible" and an answer. The first failure it
explained: after `pm clear`, Android re-prompts for `POST_NOTIFICATIONS`, and that dialog (owned by
`com.google.android.permissioncontroller`, not the app) covers the tab bar — so `tab-chats` was
found and reported not-displayed, on a screen where it was plainly visible. `resetApp` now grants
permissions before relaunching.

## Selectors

`testID` does **not** surface the same way on both platforms, and getting it wrong does not error —
it produces "element not found" against an element that is on screen. Measured with
[`scripts/probe-selectors.ts`](./scripts/probe-selectors.ts):

| | Android | iOS |
| --- | --- | --- |
| `testID` | bare **`resource-id`** — needs a `UiSelector` | `accessibilityIdentifier` — matches `~id` |
| visible label | usually **`content-desc`**, with `text` empty | composed `label` |

The Android half is the trap twice over. WebdriverIO's `~foo` shorthand is accessibility-id, which
on Android is `content-desc` — and `content-desc` holds the *label* (`logout-btn` is
`content-desc="Log out"`), not the testID. And because labels live in `content-desc` rather than
`text`, a `textContains` selector matches nothing either; text lookups have to be XPath over both
attributes.

All of this lives in [`lib/selectors.ts`](./lib/selectors.ts). Use those helpers rather than
writing selectors inline, so the next platform quirk is fixed in one place.

`TESTIDS.md` in the Maestro suite remains the canonical registry of ids — it is the contract with
`frontend/src/**`, and it is unchanged by this port.

## Layout

| Path | What |
| --- | --- |
| `lib/devices.ts` | Discovers attached phones; collapses a device attached twice |
| `lib/session.ts` | Capabilities per platform, session open, `openApp`, `resetApp` |
| `lib/selectors.ts` | `testID` → per-platform selector, and the waits built on it |
| `lib/flows.ts` | Reusable journeys — `ensureSignedIn`/`Out`, `signIn`, `gotoChats`, `openThread`, `sendMessage` |
| `lib/env.ts` | Parses `../../.env.e2e`; throws on a missing credential |
| `lib/timeouts.ts` | Every wait, with the reason for its length |
| `lib/diagnostics.ts` | Screenshot + hierarchy capture on failure |
| `tests/*.test.ts` | The tests |
| `scripts/list-devices.ts` | `npm run e2e:devices` |
| `scripts/probe-selectors.ts` | Dev aid — dump how a live screen exposes its elements |

## Conventions

- **No retries.** `retry: 0` in the config. A test that passes on the second attempt is a test that
  failed; the flake is the finding.
- **No fallbacks.** Nothing here substitutes a lesser path when something is unavailable — a
  missing credential, a missing device and a dead session all stop the run and say so.
  `isShowing` exists only to branch on genuinely non-deterministic OS UI, and must never be used to
  paper over a step that failed.
- **One test file at a time** (`fileParallelism: false`). Files share the physical phones, and two
  files driving one handset interleave taps into failures that look like app bugs.

## Ported so far

| Test | Replaces |
| --- | --- |
| `tests/login.test.ts` | `../e2e/flows/login.yaml`, plus a relaunch/persistence check |
| `tests/send-message.test.ts` | `../e2e/flows/send-message.yaml` + `lib/open-thread.yaml` + `lib/goto-chats.yaml` |

Still to port: `call-smoke`, `today`, `activity`, `connections`, `pause`, `create-org`,
`subscription`, `logout`, `full`, and the two-party orchestrators.

### Keyboards

Two of the three bugs the `send-message` port turned up were the soft keyboard, so it is worth
stating once: **Android lays the keyboard over the window; iOS insets for it.** Two consequences,
both handled in `lib/`, neither obvious from a failure message:

- A field at the bottom of the screen *disappears from the accessibility tree* once the keyboard
  covers it. So `typeInto` does not tap Android fields — uiautomator2 sets text through the
  accessibility node and needs no focus, whereas the tap would raise the keyboard over the very
  field about to be typed into. iOS keeps the tap, because XCUITest types into whatever has focus.
- Anything below that field (a submit button, the composer's Send) is equally off-screen, so
  `hideKeyboard` runs before tapping it — Android only. iOS's equivalent gesture is a tap outside
  the keyboard, which lands on whatever is underneath and navigates away.
