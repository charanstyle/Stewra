#!/usr/bin/env bash
#
# run-two-party-message.sh — drive REAL bidirectional messaging between two devices:
# device A (QA user A) sends a nonced message, device B (QA user B) is asserted to receive it live,
# then B replies and A is asserted to receive that. Both directions must pass.
#
# Why this exists alongside flows/send-message.yaml: that flow only asserts the sender's own bubble
# echoes its text back, which an optimistic local render satisfies without the message ever reaching
# the backend. Delivery is only observable on the *other* user's device, so it needs two devices
# coordinated from outside Maestro (Maestro drives one device per invocation) — the same reason
# run-two-party-call.sh exists.
#
# Unlike the call script, this is fully cross-platform in BOTH roles: receiving a message is
# ordinary in-app UI that Maestro can see on iOS and Android alike. (Answering a *call* is not —
# that is raised by the native ringer outside the app process; see run-two-party-call.sh.)
#
# Usage:
#   ./run-two-party-message.sh <device-a> <device-b> [--no-login]
#
#   device-a     Sends first, receives the reply. Signs in as USER_A.
#   device-b     Receives first, sends the reply. Signs in as USER_B.
#   --no-login   Skip signing both devices in — assume they are already signed in as A and B.
#
# A device is given as `<platform>:<id>`, or as a bare adb serial which is treated as Android:
#   android:emulator-5554   adb serial   (see `adb devices -l`)
#   ios:<UDID>              simulator    (see `xcrun simctl list devices booted`)
#
# Both devices must be explicit: pinning avoids Maestro's non-deterministic device pick when several
# are attached, and there is no sane default for which side sends first.
#
# Credentials come from the repo-root ../../.env.e2e (shared with the Playwright web suite).
# Requires E2E_USER_A/B_EMAIL/PASSWORD, plus BOTH contact display names: E2E_CONTACT_NAME (B's name
# in A's chat list) and E2E_CONTACT_NAME_A (A's name in B's chat list).
#
# Both are REQUIRED, not optional. The "blank = open the top thread" convention the single-device
# flows use cannot work here: the "Stewra" AI-assistant thread is pinned to the top of every chat
# list, so a blank name opens the assistant, and the run then reports "delivery is broken" when in
# fact the two devices were looking at different conversations. Failing here names the real problem.
#
# Requires: maestro on PATH; adb for an Android device, xcrun for an iOS one.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../../.env.e2e"
# The maestro installer drops the CLI here; add it so a fresh shell that hasn't sourced the user
# profile still finds it (mirrors the `curl … | bash` install path).
export PATH="${HOME}/.maestro/bin:${PATH}"

die() { echo "error: $*" >&2; exit 1; }

# --- args --------------------------------------------------------------------
DEV_A="${1:-}"
DEV_B="${2:-}"
NO_LOGIN=0
[[ "${3:-}" == "--no-login" ]] && NO_LOGIN=1

if [[ -z "$DEV_A" || -z "$DEV_B" ]]; then
  echo "usage: $0 <device-a> <device-b> [--no-login]" >&2
  echo "       devices are '<android|ios>:<id>', or a bare adb serial (= android)" >&2
  exit 1
fi
[[ "$DEV_A" != "$DEV_B" ]] || die "the two devices must be different"

platform_of() { case "$1" in ios:*) echo ios ;; android:*) echo android ;; *) echo android ;; esac; }
id_of()       { case "$1" in ios:*|android:*) echo "${1#*:}" ;; *) echo "$1" ;; esac; }

A_OS="$(platform_of "$DEV_A")"; A_ID="$(id_of "$DEV_A")"
B_OS="$(platform_of "$DEV_B")"; B_ID="$(id_of "$DEV_B")"
[[ -n "$A_ID" && -n "$B_ID" ]] || die "device id missing from '$DEV_A' / '$DEV_B' (expected '<platform>:<id>')"

command -v maestro >/dev/null 2>&1 || die "maestro not found on PATH"
for os in "$A_OS" "$B_OS"; do
  case "$os" in
    android) command -v adb   >/dev/null 2>&1 || die "adb not found on PATH (required for an Android device)" ;;
    ios)     command -v xcrun >/dev/null 2>&1 || die "xcrun not found on PATH (required for an iOS simulator)" ;;
  esac
done

# --- credentials -------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || die "missing shared secrets file at ${ENV_FILE} (cp ../../.env.e2e.example and fill it in)"
# shellcheck source=lib/load-env.sh
source "${SCRIPT_DIR}/lib/load-env.sh"
load_env_file "$ENV_FILE"
for var in E2E_USER_A_EMAIL E2E_USER_A_PASSWORD E2E_USER_B_EMAIL E2E_USER_B_PASSWORD; do
  [[ -n "${!var:-}" ]] || die "${var} is not set in ${ENV_FILE}"
done
# Both thread selectors are required — see the header. Blank would open the pinned "Stewra" assistant
# thread on both devices and turn a harness misconfiguration into a false "delivery is broken" report.
for var in E2E_CONTACT_NAME E2E_CONTACT_NAME_A; do
  [[ -n "${!var:-}" ]] || die "${var} is not set in ${ENV_FILE} — this run needs BOTH contact display names (a blank value opens the pinned Stewra assistant thread, not the human conversation)"
done
CONTACT_B="$E2E_CONTACT_NAME"
CONTACT_A="$E2E_CONTACT_NAME_A"

# --- verify both devices are attached/booted ---------------------------------
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
verify_device "$A_OS" "$A_ID"
verify_device "$B_OS" "$B_ID"

# Nonce the payloads so a passing assertion can only be THIS run's message — a fixed string would
# still be on screen from a previous run and would pass without anything being delivered.
NONCE="$$-$(date +%s)"
MSG_AB="maestro A→B ${NONCE}"
MSG_BA="maestro B→A ${NONCE}"

run_flow() { # <device-id> <flow> [--env K=V ...]
  local id="$1" flow="$2"; shift 2
  maestro --device "$id" test "$@" "$flow"
}

SEND="${SCRIPT_DIR}/flows/send-message.yaml"
RECV="${SCRIPT_DIR}/flows/two-party/receive-message.yaml"
[[ -f "$SEND" ]] || die "missing flow ${SEND}"
[[ -f "$RECV" ]] || die "missing flow ${RECV}"

# --- 1. sign both devices in (unless --no-login) -----------------------------
if [[ "$NO_LOGIN" -eq 1 ]]; then
  echo "==> Skipping login (--no-login); assuming A/B already signed in"
else
  echo "==> Signing in ${DEV_A} as ${E2E_USER_A_EMAIL}"
  run_flow "$A_ID" "${SCRIPT_DIR}/flows/login.yaml" \
    --env EMAIL="$E2E_USER_A_EMAIL" --env PASSWORD="$E2E_USER_A_PASSWORD" \
    || die "login failed on ${DEV_A}"
  echo "==> Signing in ${DEV_B} as ${E2E_USER_B_EMAIL}"
  run_flow "$B_ID" "${SCRIPT_DIR}/flows/login.yaml" \
    --env EMAIL="$E2E_USER_B_EMAIL" --env PASSWORD="$E2E_USER_B_PASSWORD" \
    || die "login failed on ${DEV_B}"
fi

# --- 2. A → B ----------------------------------------------------------------
echo "==> A sends on ${DEV_A}: '${MSG_AB}'"
run_flow "$A_ID" "$SEND" --env CONTACT_NAME="$CONTACT_B" --env MESSAGE_TEXT="$MSG_AB" \
  || die "sending A→B failed on ${DEV_A}"
echo "==> Asserting B receives it on ${DEV_B}"
run_flow "$B_ID" "$RECV" --env CONTACT_NAME="$CONTACT_A" --env MESSAGE_TEXT="$MSG_AB" \
  || die "A→B message never arrived on ${DEV_B} — delivery is broken (the sender's own echo passed)"

# --- 3. B → A (reply on the same thread B is already in) ---------------------
echo "==> B replies on ${DEV_B}: '${MSG_BA}'"
run_flow "$B_ID" "$SEND" --env CONTACT_NAME="$CONTACT_A" --env MESSAGE_TEXT="$MSG_BA" \
  || die "sending B→A failed on ${DEV_B}"
echo "==> Asserting A receives the reply on ${DEV_A}"
run_flow "$A_ID" "$RECV" --env CONTACT_NAME="$CONTACT_B" --env MESSAGE_TEXT="$MSG_BA" \
  || die "B→A reply never arrived on ${DEV_A} — delivery is broken in the reverse direction"

echo ""
echo "==================== PASS ===================="
echo "Bidirectional messaging: ${DEV_A} (A) ↔ ${DEV_B} (B), both directions delivered live."
echo "  A→B: ${MSG_AB}"
echo "  B→A: ${MSG_BA}"
