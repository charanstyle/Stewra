#!/usr/bin/env bash
#
# reset-devices.sh — sign every attached Android device out of the Stewra app by
# clearing its app data (wipes expo-secure-store, so the next launch is signed out).
#
# Why this exists: WebRTC calls fan out to ALL of a user's logged-in devices. A
# phone or emulator still signed in as a test user will grab an incoming call and
# break a browser-to-browser handshake. Run this before the website call suite, or
# any time you want the mobile devices out of the way.
#
# Usage:
#   ./reset-devices.sh                 # clear on every attached device
#   ./reset-devices.sh <serial>        # clear on one device (see: adb devices -l)
#   APP_ID=com.example.app ./reset-devices.sh   # override the package
#
# Requires: adb on PATH (Android platform-tools).
set -euo pipefail

APP_ID="${APP_ID:-com.stewra.app}"

if ! command -v adb >/dev/null 2>&1; then
  echo "error: adb not found on PATH. Install Android platform-tools." >&2
  exit 1
fi

# Collect target serials: an explicit arg, else every device in state "device".
serials=()
if [[ $# -ge 1 ]]; then
  serials=("$1")
else
  while read -r serial state _; do
    [[ "$state" == "device" ]] && serials+=("$serial")
  done < <(adb devices | tail -n +2)
fi

if [[ ${#serials[@]} -eq 0 ]]; then
  echo "No attached Android devices found (adb devices)." >&2
  exit 1
fi

echo "Clearing ${APP_ID} on ${#serials[@]} device(s)..."
failed=0
for serial in "${serials[@]}"; do
  printf '  %-20s ' "$serial"
  if adb -s "$serial" shell pm clear "$APP_ID" 2>/dev/null | grep -q Success; then
    echo "signed out"
  else
    echo "FAILED (is the app installed?)"
    failed=1
  fi
done

exit "$failed"
