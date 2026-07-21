#!/usr/bin/env bash
#
# run-features.sh — run a single Maestro flow against a pinned device, sourcing
# credentials from the repo-root shared secrets file.
#
# Why pin the device: `maestro test` with no --device picks a target
# non-deterministically when more than one device/emulator is attached or booted
# (e.g. a background Android emulator plus a phone plugged in over USB) — a
# documented Maestro gotcha. Always resolve and pass an explicit device.
#
# Usage:
#   ./run-features.sh <flow.yaml> <platform> [device-udid]
#
#   flow.yaml    Path to a flow, relative to this directory or to flows/
#                (e.g. "login.yaml" or "flows/login.yaml"), or an absolute path.
#   platform     "android" or "ios".
#   device-udid  Optional. Skips auto-resolution and targets this device/serial
#                directly (from `adb devices -l` for android, or
#                `xcrun simctl list devices` for ios).
#
# Credentials: sourced from the repo-root ../../.env.e2e (shared with the
# Playwright web suite). See ../../.env.e2e.example. Fails loudly if missing —
# never falls back to hardcoded/default credentials.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../../.env.e2e"

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <flow.yaml> <android|ios> [device-udid]" >&2
  exit 1
fi

FLOW_ARG="$1"
PLATFORM="$2"
EXPLICIT_UDID="${3:-}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: missing shared secrets file at ${ENV_FILE}" >&2
  echo "       cp $(cd "${SCRIPT_DIR}/../.." && pwd)/.env.e2e.example ${ENV_FILE} and fill it in." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

for var in E2E_USER_A_EMAIL E2E_USER_A_PASSWORD; do
  if [[ -z "${!var:-}" ]]; then
    echo "error: ${var} is not set in ${ENV_FILE}" >&2
    exit 1
  fi
done

if ! command -v maestro >/dev/null 2>&1; then
  echo "error: maestro CLI not found on PATH. Install: curl -Ls \"https://get.maestro.mobile.dev\" | bash" >&2
  exit 1
fi

# Resolve the flow file: as given, else under this directory, else under flows/.
if [[ -f "$FLOW_ARG" ]]; then
  FLOW_PATH="$FLOW_ARG"
elif [[ -f "${SCRIPT_DIR}/${FLOW_ARG}" ]]; then
  FLOW_PATH="${SCRIPT_DIR}/${FLOW_ARG}"
elif [[ -f "${SCRIPT_DIR}/flows/${FLOW_ARG}" ]]; then
  FLOW_PATH="${SCRIPT_DIR}/flows/${FLOW_ARG}"
else
  echo "error: could not find flow '${FLOW_ARG}' (looked in cwd, ${SCRIPT_DIR}, and ${SCRIPT_DIR}/flows)" >&2
  exit 1
fi

# Resolve the device to pin.
DEVICE_ID=""
if [[ -n "$EXPLICIT_UDID" ]]; then
  DEVICE_ID="$EXPLICIT_UDID"
elif [[ "$PLATFORM" == "android" ]]; then
  if ! command -v adb >/dev/null 2>&1; then
    echo "error: adb not found on PATH. Install Android platform-tools." >&2
    exit 1
  fi
  mapfile -t ANDROID_DEVICES < <(adb devices | tail -n +2 | awk '$2 == "device" { print $1 }')
  if [[ ${#ANDROID_DEVICES[@]} -eq 0 ]]; then
    echo "error: no attached Android devices/emulators found (adb devices)." >&2
    exit 1
  elif [[ ${#ANDROID_DEVICES[@]} -gt 1 ]]; then
    echo "error: multiple Android devices attached (${ANDROID_DEVICES[*]}); pass one explicitly as the third arg." >&2
    exit 1
  fi
  DEVICE_ID="${ANDROID_DEVICES[0]}"
elif [[ "$PLATFORM" == "ios" ]]; then
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "error: xcrun not found on PATH. iOS device resolution requires Xcode command line tools." >&2
    exit 1
  fi
  mapfile -t IOS_DEVICES < <(xcrun simctl list devices booted | grep -Eo '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}')
  if [[ ${#IOS_DEVICES[@]} -eq 0 ]]; then
    echo "error: no booted iOS simulators found (xcrun simctl list devices booted). Boot one or pass a UDID explicitly." >&2
    exit 1
  elif [[ ${#IOS_DEVICES[@]} -gt 1 ]]; then
    echo "error: multiple booted iOS simulators (${IOS_DEVICES[*]}); pass one explicitly as the third arg." >&2
    exit 1
  fi
  DEVICE_ID="${IOS_DEVICES[0]}"
else
  echo "error: unknown platform '${PLATFORM}' (expected 'android' or 'ios')" >&2
  exit 1
fi

echo "==> Running $(basename "$FLOW_PATH") on ${PLATFORM} device ${DEVICE_ID}"
maestro --device "$DEVICE_ID" test \
  --env EMAIL="$E2E_USER_A_EMAIL" \
  --env PASSWORD="$E2E_USER_A_PASSWORD" \
  --env CONTACT_NAME="${E2E_CONTACT_NAME:-}" \
  --env RUNNER_MACHINE="${E2E_RUNNER_MACHINE:-}" \
  --env RUNNER_WORKSPACE="${E2E_RUNNER_WORKSPACE:-}" \
  --env RUNNER_HARNESS="${E2E_RUNNER_HARNESS:-}" \
  "$FLOW_PATH"
