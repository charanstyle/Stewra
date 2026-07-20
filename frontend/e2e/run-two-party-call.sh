#!/usr/bin/env bash
#
# run-two-party-call.sh — drive a REAL two-party WebRTC call between two Android
# devices: one places the call (caller = QA user A), the other answers it
# (callee = QA user B), both ends are asserted to reach the connected state, then
# the caller hangs up and both are asserted to leave the call cleanly.
#
# This is the durable form of the orchestration that was proven live on 2026-07-19
# (emulator Pixel_9_Pro as A ↔ USB Pixel 8 as B, release APK, voice AND video).
# Maestro drives a single device, so a two-party call can't be one flow; this
# script coordinates two devices with Maestro + adb.
#
# Why adb-taps the incoming-call notification instead of a Maestro `tapOn`:
# callkit-telecom raises the incoming call as a SYSTEM heads-up notification, not
# a React view — its "Answer" affordance has no testID, its visible text is
# bidi-wrapped junk (`⁦…⁨Answer⁩⁩`), and a cold `maestro test`
# is too slow to catch it before the ring times out. We read the live view
# hierarchy (which cleanly exposes `accessibilityText: "Answer"` with pixel
# bounds), compute the button centre, and `adb ... input tap` it directly — fast
# and reliable. (Answer and Decline share `resource-id=android:id/action0`, so the
# accessibility label is the discriminator.)
#
# Usage:
#   ./run-two-party-call.sh <voice|video> <caller-serial> <callee-serial> [--no-login]
#
#   voice|video     Call kind to place from the caller.
#   caller-serial   adb serial of device A (places the call; signs in as USER_A).
#   callee-serial   adb serial of device B (answers; signs in as USER_B).
#   --no-login      Skip signing both devices in — assume they are already signed
#                   in as A and B respectively (e.g. after a previous run).
#
# Both serials must be explicit (see `adb devices -l`): pinning avoids Maestro's
# non-deterministic device pick when several are attached, and there is no sane
# default for "which device is the caller".
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
  echo "usage: $0 <voice|video> <caller-serial> <callee-serial> [--no-login]" >&2
  exit 1 ;;
esac
[[ -n "$CALLER" && -n "$CALLEE" ]] || die "both caller and callee serials are required (adb devices -l)"
[[ "$CALLER" != "$CALLEE" ]] || die "caller and callee must be different devices"

for tool in adb maestro python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
done

# --- credentials -------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || die "missing shared secrets file at ${ENV_FILE} (cp ../../.env.e2e.example and fill it in)"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
for var in E2E_USER_A_EMAIL E2E_USER_A_PASSWORD E2E_USER_B_EMAIL E2E_USER_B_PASSWORD E2E_CONTACT_NAME; do
  [[ -n "${!var:-}" ]] || die "${var} is not set in ${ENV_FILE}"
done

# --- verify both serials are actually attached and ready ---------------------
for serial in "$CALLER" "$CALLEE"; do
  state="$(adb devices | awk -v s="$serial" '$1 == s { print $2 }')"
  [[ "$state" == "device" ]] || die "device ${serial} is not attached/ready (adb devices reports '${state:-absent}')"
done

CALL_START_ID="call-start-${CALL_KIND}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run_flow() { # <serial> <flow-file> [--env K=V ...]
  local serial="$1" flow="$2"; shift 2
  maestro --device "$serial" test "$@" "$flow"
}

# --- 1. pre-grant runtime permissions so no OS dialog blocks the flow --------
echo "==> Granting call permissions on both devices"
for serial in "$CALLER" "$CALLEE"; do
  for perm in RECORD_AUDIO CAMERA POST_NOTIFICATIONS; do
    adb -s "$serial" shell pm grant "$APP_ID" "android.permission.${perm}" >/dev/null 2>&1 || true
  done
done

# --- 2. sign both devices in (unless --no-login) -----------------------------
if [[ "$NO_LOGIN" -eq 1 ]]; then
  echo "==> Skipping login (--no-login); assuming A/B already signed in"
else
  echo "==> Signing in caller ${CALLER} as ${E2E_USER_A_EMAIL}"
  run_flow "$CALLER" "${SCRIPT_DIR}/flows/login.yaml" \
    --env EMAIL="$E2E_USER_A_EMAIL" --env PASSWORD="$E2E_USER_A_PASSWORD" \
    || die "caller login failed"
  echo "==> Signing in callee ${CALLEE} as ${E2E_USER_B_EMAIL}"
  run_flow "$CALLEE" "${SCRIPT_DIR}/flows/login.yaml" \
    --env EMAIL="$E2E_USER_B_EMAIL" --env PASSWORD="$E2E_USER_B_PASSWORD" \
    || die "callee login failed"
fi

# --- 3. place the call on the caller -----------------------------------------
# Opens B's thread and taps the voice/video call button. The flow returns as soon
# as the outgoing call screen is up (call-end visible) — the call keeps ringing
# after Maestro exits, which is what lets us answer on B next.
cat > "${WORK}/place-call.yaml" <<YAML
appId: ${APP_ID}
---
- runFlow:
    when:
      notVisible: "Chats"
    commands:
      - pressKey: Back
- assertVisible: "Chats"
- tapOn:
    id: "tab-chats"
- tapOn: \${CONTACT_NAME}
- tapOn:
    id: "${CALL_START_ID}"
- extendedWaitUntil:
    visible:
      id: "call-end"
    timeout: 15000
YAML
echo "==> Placing ${CALL_KIND} call on ${CALLER} to '${E2E_CONTACT_NAME}'"
run_flow "$CALLER" "${WORK}/place-call.yaml" --env CONTACT_NAME="$E2E_CONTACT_NAME" \
  || die "placing the call failed (is the caller on this contact's thread reachable?)"

# --- 4. answer on the callee by tapping the incoming-call notification --------
echo "==> Waiting for the incoming call on ${CALLEE} and answering it"
answer_deadline=$(( $(date +%s) + 45 ))
answered=0
while [[ "$(date +%s)" -lt "$answer_deadline" ]]; do
  center="$(maestro --device "$CALLEE" hierarchy --no-ansi 2>/dev/null | python3 - <<'PY'
import json, re, sys
raw = sys.stdin.read()
i = raw.find('{')
if i == -1:
    sys.exit(0)
try:
    data = json.loads(raw[i:])
except Exception:
    sys.exit(0)

hit = None
def walk(node):
    global hit
    if hit is not None or not isinstance(node, dict):
        return
    a = node.get('attributes', {}) or {}
    label = (a.get('accessibilityText') or '') + ' ' + (a.get('text') or '')
    if re.search(r'answer', label, re.I):
        m = re.search(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', a.get('bounds') or '')
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            hit = ((x1 + x2) // 2, (y1 + y2) // 2)
            return
    for c in (node.get('children') or []):
        walk(c)
walk(data)
if hit:
    print(hit[0], hit[1])
PY
)"
  if [[ -n "$center" ]]; then
    echo "    Answer button at (${center}); tapping"
    adb -s "$CALLEE" shell input tap $center
    answered=1
    break
  fi
  sleep 1
done
[[ "$answered" -eq 1 ]] || die "incoming call never appeared on ${CALLEE} within 45s (did the ring reach it? is B a contact of A?)"

# --- 5. assert both ends reach the connected state ---------------------------
# Voice: the "Connected" status label is shown on both ends → assert it.
# Video: once media flows the label is replaced by the remote video surface (no
# testID), so the reliable cross-device signal is that the in-call screen persists
# (call-end still present a few seconds later) and the ringing labels are gone.
if [[ "$CALL_KIND" == "voice" ]]; then
  cat > "${WORK}/assert-connected.yaml" <<YAML
appId: ${APP_ID}
---
- extendedWaitUntil:
    visible:
      text: "Connected"
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
- assertNotVisible: "Calling…"
- assertNotVisible: "Incoming call…"
YAML
fi
echo "==> Asserting connected on caller ${CALLER}"
run_flow "$CALLER" "${WORK}/assert-connected.yaml" || die "caller never reached the connected state"
echo "==> Asserting connected on callee ${CALLEE}"
run_flow "$CALLEE" "${WORK}/assert-connected.yaml" || die "callee never reached the connected state"
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
run_flow "$CALLER" "${WORK}/hangup.yaml" || die "hang up on caller failed"
echo "==> Asserting the call ended on both devices"
run_flow "$CALLER" "${WORK}/assert-ended.yaml" || die "caller did not leave the call screen"
run_flow "$CALLEE" "${WORK}/assert-ended.yaml" || die "callee did not leave the call screen"

echo ""
echo "==================== PASS ===================="
echo "Two-party ${CALL_KIND} call: placed on ${CALLER}, answered on ${CALLEE}, connected, hung up cleanly."
