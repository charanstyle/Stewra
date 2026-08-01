#!/usr/bin/env bash
#
# run-two-party-call.sh — drive a REAL two-party WebRTC call between two devices:
# one places the call (caller = QA user A), the other answers it (callee = QA user
# B), both ends are asserted to reach the connected state, then the caller hangs up
# and both are asserted to leave the call cleanly. The caller may be an iOS
# simulator or an Android device; the callee must be Android (see CROSS-PLATFORM).
#
# This is the durable form of the orchestration that was proven live on 2026-07-19
# (emulator Pixel_9_Pro as A ↔ USB Pixel 8 as B, release APK, voice AND video).
# Maestro drives a single device, so a two-party call can't be one flow; this
# script coordinates two devices with Maestro + adb.
#
# Why adb-taps the incoming-call notification instead of a Maestro `tapOn`:
# callkit-telecom raises the incoming call as a SYSTEM notification owned by
# com.android.systemui, not a React view — its "Answer" affordance has no testID,
# its visible text is bidi-wrapped junk (`⁦…⁨Answer⁩⁩`), and a cold `maestro test`
# is too slow to catch it before the ring times out. We read the SystemUI view
# hierarchy with `uiautomator dump` (which exposes `content-desc="Answer"` with
# pixel bounds), compute the button centre, and `adb ... input tap` it directly.
# (Answer and Decline share `resource-id=android:id/action0`, so the accessibility
# label is the discriminator.) See step 4 for why Maestro cannot be used to read
# that tree and why the shade has to be expanded first.
#
# Usage:
#   ./run-two-party-call.sh <voice|video> <caller-device> <callee-device> [--no-login]
#
#   voice|video     Call kind to place from the caller.
#   caller-device   Device A (places the call; signs in as USER_A).
#   callee-device   Device B (answers; signs in as USER_B). Must be Android — see below.
#   --no-login      Skip signing both devices in — assume they are already signed
#                   in as A and B respectively (e.g. after a previous run).
#
# A device is given as `<platform>:<id>`, or as a bare adb serial which is treated
# as Android (so the original Android-only invocations below still work verbatim):
#   android:emulator-5554   adb serial   (see `adb devices -l`)
#   ios:<UDID>              simulator    (see `xcrun simctl list devices booted`)
#
# Both devices must be explicit: pinning avoids Maestro's non-deterministic device
# pick when several are attached, and there is no sane default for "which device is
# the caller".
#
# CROSS-PLATFORM: the CALLER may be iOS or Android; the CALLEE must be Android.
# Answering is the asymmetry — incoming calls are raised by the *native* ringer
# (CallKit on iOS, Core-Telecom on Android), not by an in-app React screen, so there
# is no `Answer` testID to tap on either platform. On Android the ringer is a system
# notification that `adb shell input tap` can hit at computed coordinates (step 4).
# On iOS the CallKit UI lives outside the app process: Maestro's hierarchy cannot
# see it, and `simctl` has no input-tap equivalent — so an iOS callee cannot be
# answered programmatically here and is rejected up front rather than hanging for
# 45s. iOS-as-caller is fully supported (placing a call is ordinary in-app UI).
#
# Credentials + the contact to call are sourced from the repo-root ../../.env.e2e
# (shared with the Playwright web suite). Requires E2E_USER_A/B_EMAIL/PASSWORD and
# E2E_CONTACT_NAME (B's display name as it appears in A's chat list). Fails loudly
# if any are missing — never falls back to hardcoded credentials.
#
# Requires: adb (Android platform-tools), maestro, python3, all on PATH.
set -uo pipefail

APP_ID="com.stewra.app"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../../.env.e2e"
# The maestro installer drops the CLI here; add it so a fresh shell that hasn't
# sourced the user profile still finds it (mirrors `curl … | bash` install path).
export PATH="${HOME}/.maestro/bin:${PATH}"

die() { echo "error: $*" >&2; exit 1; }

# --- args --------------------------------------------------------------------
CALL_KIND="${1:-}"
CALLER="${2:-}"
CALLEE="${3:-}"
NO_LOGIN=0
[[ "${4:-}" == "--no-login" ]] && NO_LOGIN=1

case "$CALL_KIND" in voice|video) ;; *)
  echo "usage: $0 <voice|video> <caller-device> <callee-device> [--no-login]" >&2
  echo "       devices are '<android|ios>:<id>', or a bare adb serial (= android)" >&2
  exit 1 ;;
esac
[[ -n "$CALLER" && -n "$CALLEE" ]] || die "both caller and callee devices are required (see 'adb devices -l' / 'xcrun simctl list devices booted')"
[[ "$CALLER" != "$CALLEE" ]] || die "caller and callee must be different devices"

# Split a `<platform>:<id>` spec. A bare value is Android, keeping the original
# two-adb-serial invocations working unchanged.
platform_of() { case "$1" in ios:*) echo ios ;; android:*) echo android ;; *) echo android ;; esac; }
id_of()       { case "$1" in ios:*|android:*) echo "${1#*:}" ;; *) echo "$1" ;; esac; }

CALLER_OS="$(platform_of "$CALLER")"; CALLER_ID="$(id_of "$CALLER")"
CALLEE_OS="$(platform_of "$CALLEE")"; CALLEE_ID="$(id_of "$CALLEE")"
[[ -n "$CALLER_ID" && -n "$CALLEE_ID" ]] || die "device id missing from '$CALLER' / '$CALLEE' (expected '<platform>:<id>')"

# See the CROSS-PLATFORM note in the header: there is no way to tap iOS's CallKit
# ringer from here, so fail now with the reason instead of timing out in step 4.
[[ "$CALLEE_OS" == "android" ]] || die "the callee must be Android: iOS answers via the CallKit system UI, which Maestro cannot see and simctl cannot tap. Swap the roles so the iOS device places the call."

for tool in maestro python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
done
# adb is always needed (the callee is Android); xcrun only for an iOS caller.
command -v adb >/dev/null 2>&1 || die "adb not found on PATH (required for the Android callee)"
if [[ "$CALLER_OS" == "ios" ]]; then
  command -v xcrun >/dev/null 2>&1 || die "xcrun not found on PATH (required for an iOS caller)"
fi

# --- credentials -------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || die "missing shared secrets file at ${ENV_FILE} (cp ../../.env.e2e.example and fill it in)"
# shellcheck source=lib/load-env.sh
source "${SCRIPT_DIR}/lib/load-env.sh"
load_env_file "$ENV_FILE"
for var in E2E_USER_A_EMAIL E2E_USER_A_PASSWORD E2E_USER_B_EMAIL E2E_USER_B_PASSWORD E2E_CONTACT_NAME; do
  [[ -n "${!var:-}" ]] || die "${var} is not set in ${ENV_FILE}"
done

# --- verify both devices are actually attached/booted and ready --------------
verify_device() { # <platform> <id>
  case "$1" in
    android)
      local state
      state="$(adb devices | awk -v s="$2" '$1 == s { print $2 }')"
      [[ "$state" == "device" ]] || die "android device ${2} is not attached/ready (adb devices reports '${state:-absent}')"
      ;;
    ios)
      xcrun simctl list devices booted | grep -qi "$2" \
        || die "ios simulator ${2} is not booted (xcrun simctl list devices booted)"
      ;;
  esac
}
verify_device "$CALLER_OS" "$CALLER_ID"
verify_device "$CALLEE_OS" "$CALLEE_ID"

CALL_START_ID="call-start-${CALL_KIND}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run_flow() { # <serial> <flow-file> [--env K=V ...]
  local serial="$1" flow="$2"; shift 2
  maestro --device "$serial" test "$@" "$flow"
}

# --- 1. pre-grant runtime permissions so no OS dialog blocks the flow --------
echo "==> Granting call permissions on both devices"
grant_perms() { # <platform> <id>
  case "$1" in
    android)
      for perm in RECORD_AUDIO CAMERA POST_NOTIFICATIONS; do
        adb -s "$2" shell pm grant "$APP_ID" "android.permission.${perm}" >/dev/null 2>&1 || true
      done
      # Step 4 opens the notification shade to reach the Answer button, and a run that dies between
      # opening and collapsing it leaves the shade covering the screen. The next run then fails at
      # login with "Sign in is not visible" — a stale shade from a *previous* invocation reported as
      # a login failure. Collapsing here makes each run independent of how the last one ended.
      adb -s "$2" shell cmd statusbar collapse >/dev/null 2>&1 || true
      ;;
    ios)
      # Pre-granting keeps the mic/camera consent alert from covering the call UI. Best-effort,
      # like the Android grants above: the alert may simply not appear on a given simulator.
      for svc in microphone camera; do
        xcrun simctl privacy "$2" grant "$svc" "$APP_ID" >/dev/null 2>&1 || true
      done
      ;;
  esac
}
grant_perms "$CALLER_OS" "$CALLER_ID"
grant_perms "$CALLEE_OS" "$CALLEE_ID"

# --- 2. sign both devices in (unless --no-login) -----------------------------
if [[ "$NO_LOGIN" -eq 1 ]]; then
  echo "==> Skipping login (--no-login); assuming A/B already signed in"
else
  echo "==> Signing in caller ${CALLER} as ${E2E_USER_A_EMAIL}"
  run_flow "$CALLER_ID" "${SCRIPT_DIR}/flows/login.yaml" \
    --env EMAIL="$E2E_USER_A_EMAIL" --env PASSWORD="$E2E_USER_A_PASSWORD" \
    || die "caller login failed"
  echo "==> Signing in callee ${CALLEE} as ${E2E_USER_B_EMAIL}"
  run_flow "$CALLEE_ID" "${SCRIPT_DIR}/flows/login.yaml" \
    --env EMAIL="$E2E_USER_B_EMAIL" --env PASSWORD="$E2E_USER_B_PASSWORD" \
    || die "callee login failed"
fi

# --- 3. place the call on the caller -----------------------------------------
# Opens B's thread and taps the voice/video call button. The flow returns as soon
# as the outgoing call screen is up (call-end visible) — the call keeps ringing
# after Maestro exits, which is what lets us answer on B next.
#
# The "get to the thread" preamble is delegated to flows/lib/open-thread.yaml rather
# than inlined. It used to be inlined as `pressKey: Back` + a bare `tapOn:
# ${CONTACT_NAME}`, and both are broken on iOS — Back is a no-op with no hardware
# key, and a chat row is a single accessibility element whose label concatenates
# every child, so a bare contact name never matches. Since the caller is the role
# iOS *can* take, this flow is the one that runs there. The path is absolute
# because this file is generated into a mktemp dir and Maestro resolves runFlow
# relative to the flow file.
cat > "${WORK}/place-call.yaml" <<YAML
appId: ${APP_ID}
---
- runFlow: ${SCRIPT_DIR}/flows/lib/open-thread.yaml
- tapOn:
    id: "${CALL_START_ID}"
- extendedWaitUntil:
    visible:
      id: "call-end"
    timeout: 15000
YAML
echo "==> Placing ${CALL_KIND} call on ${CALLER} to '${E2E_CONTACT_NAME}'"
run_flow "$CALLER_ID" "${WORK}/place-call.yaml" --env CONTACT_NAME="$E2E_CONTACT_NAME" \
  || die "placing the call failed (is the caller on this contact's thread reachable?)"

# --- 4. answer on the callee by tapping the incoming-call notification --------
#
# The ringer is the OS's, not ours: there is no in-app incoming-call screen on
# Android (src/services/call/voipCallService.ts hands the call to Core-Telecom,
# which posts the notification with the Decline/Answer actions). So the only
# affordance to tap belongs to com.android.systemui, and two things follow.
#
# 1. Read the tree with `uiautomator dump`, NOT `maestro hierarchy`. Maestro's
#    Android hierarchy is scoped to the app under test, so the SystemUI window is
#    simply absent from it — the previous version of this loop polled Maestro and
#    got zero matches for 45s while the Answer button was plainly on screen.
# 2. Expand the notification shade first. A heads-up notification does not take
#    window focus and is not in the dumpable window set; expanding the shade puts
#    the same notification, with the same actions, into a window uiautomator can
#    see.
# 3. Expand once and let it settle, then only re-expand when a dump comes back
#    without SystemUI in it. `uiautomator dump` blocks until the window is idle,
#    so re-issuing expand-notifications on every poll would restart the shade
#    animation and dump into it.
#
# The button carries content-desc="Answer" and a text of "⁦📞 ⁨Answer⁩⁩" — the label
# is wrapped in Unicode bidi isolates and prefixed with an emoji, so match on a
# substring rather than equality, and prefer content-desc.
#
# The parser lives in a file and takes the XML as an ARGUMENT rather than on stdin.
# That is not a style choice: `… | python3 - <<'PY'` looks like it pipes the dump in,
# but `python3 -` reads the *program* from stdin and the heredoc wins the redirection,
# so `sys.stdin.read()` returns "" and the match can never succeed. That single line
# is what produced "incoming call never appeared" on every run while a screenshot,
# the notification record, and a hand-run `uiautomator dump` all plainly showed the
# Answer button on screen. Keep the XML out of stdin.
cat > "${WORK}/find-answer.py" <<'PY'
import re, sys

raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()

hit = None
for node in re.finditer(r'<node[^>]*/?>', raw):
    s = node.group(0)
    if 'clickable="true"' not in s:
        continue
    label = ' '.join(re.findall(r'(?:text|content-desc)="([^"]*)"', s))
    if not re.search(r'answer', label, re.I):
        continue
    m = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', s)
    if m:
        x1, y1, x2, y2 = map(int, m.groups())
        hit = ((x1 + x2) // 2, (y1 + y2) // 2)
        break
if hit:
    print(hit[0], hit[1])
PY

echo "==> Waiting for the incoming call on ${CALLEE} and answering it"
adb -s "$CALLEE_ID" shell cmd statusbar expand-notifications >/dev/null 2>&1 || true
sleep 2
answer_deadline=$(( $(date +%s) + 45 ))
answered=0
while [[ "$(date +%s)" -lt "$answer_deadline" ]]; do
  adb -s "$CALLEE_ID" shell uiautomator dump /sdcard/e2e-ring.xml >/dev/null 2>&1 || true
  adb -s "$CALLEE_ID" exec-out cat /sdcard/e2e-ring.xml > "${WORK}/ring.xml" 2>/dev/null || true
  if ! grep -q "com.android.systemui" "${WORK}/ring.xml" 2>/dev/null; then
    # The shade closed (or never opened) — reopen it and let it settle before the
    # next dump rather than dumping into the animation.
    adb -s "$CALLEE_ID" shell cmd statusbar expand-notifications >/dev/null 2>&1 || true
    sleep 2
    adb -s "$CALLEE_ID" shell uiautomator dump /sdcard/e2e-ring.xml >/dev/null 2>&1 || true
    adb -s "$CALLEE_ID" exec-out cat /sdcard/e2e-ring.xml > "${WORK}/ring.xml" 2>/dev/null || true
  fi
  center="$(python3 "${WORK}/find-answer.py" "${WORK}/ring.xml")"
  if [[ -n "$center" ]]; then
    echo "    Answer button at (${center}); tapping"
    adb -s "$CALLEE_ID" shell input tap $center
    answered=1
    break
  fi
  sleep 1
done
[[ "$answered" -eq 1 ]] || die "incoming call never appeared on ${CALLEE} within 45s (did the ring reach it? is B a contact of A?)"

# The shade was opened to reach the button. Answering normally collapses it, but a
# shade left open covers the in-call screen and every assertion in step 5 would fail
# against SystemUI instead of the app, so close it explicitly.
sleep 2
adb -s "$CALLEE_ID" shell cmd statusbar collapse >/dev/null 2>&1 || true

# --- 5. assert both ends reach the connected state ---------------------------
# Voice: the "Connected" status label is shown on both ends → assert it.
# Video: once media flows the label is replaced by the remote video surface (no
# testID), so the reliable cross-device signal is that the in-call screen persists
# (call-end still present a few seconds later) and the ringing labels are gone.
#
# Every text selector below is `.*`-wrapped because Maestro matches text as a
# whole-string regex and iOS composes a container's children into one label. For
# the visible waits that is required to match at all; for the assertNotVisible
# checks it only makes them stricter (a bare "Calling…" would silently pass against
# a composed label that still contains it).
if [[ "$CALL_KIND" == "voice" ]]; then
  cat > "${WORK}/assert-connected.yaml" <<YAML
appId: ${APP_ID}
---
- extendedWaitUntil:
    visible:
      text: ".*Connected.*"
    timeout: 25000
- assertVisible:
    id: "call-end"
YAML
else
  cat > "${WORK}/assert-connected.yaml" <<YAML
appId: ${APP_ID}
---
- extendedWaitUntil:
    visible:
      id: "call-end"
    timeout: 25000
- assertNotVisible: ".*Calling….*"
- assertNotVisible: ".*Incoming call….*"
YAML
fi
echo "==> Asserting connected on caller ${CALLER}"
run_flow "$CALLER_ID" "${WORK}/assert-connected.yaml" || die "caller never reached the connected state"
echo "==> Asserting connected on callee ${CALLEE}"
run_flow "$CALLEE_ID" "${WORK}/assert-connected.yaml" || die "callee never reached the connected state"
echo "==> Two-party ${CALL_KIND} call CONNECTED on both devices"

# --- 6. hang up on the caller and assert both leave the call -----------------
cat > "${WORK}/hangup.yaml" <<YAML
appId: ${APP_ID}
---
- tapOn:
    id: "call-end"
YAML
cat > "${WORK}/assert-ended.yaml" <<YAML
appId: ${APP_ID}
---
- extendedWaitUntil:
    notVisible:
      id: "call-end"
    timeout: 15000
YAML
echo "==> Hanging up on caller ${CALLER}"
run_flow "$CALLER_ID" "${WORK}/hangup.yaml" || die "hang up on caller failed"
echo "==> Asserting the call ended on both devices"
run_flow "$CALLER_ID" "${WORK}/assert-ended.yaml" || die "caller did not leave the call screen"
run_flow "$CALLEE_ID" "${WORK}/assert-ended.yaml" || die "callee did not leave the call screen"

echo ""
echo "==================== PASS ===================="
echo "Two-party ${CALL_KIND} call: placed on ${CALLER}, answered on ${CALLEE}, connected, hung up cleanly."
