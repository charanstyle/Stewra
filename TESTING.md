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

## Not wired into CI

The suites are **run locally, one command each** (Truetalk's aren't in CI either). There is no
`.github/workflows/` running Playwright or Maestro yet.
