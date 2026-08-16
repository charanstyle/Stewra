#!/usr/bin/env bash
#
# run-all-features.sh — run every flow in flows/ in sequence via run-features.sh,
# pinned to one device, and print a PASS/FAIL summary.
#
# Usage:
#   ./run-all-features.sh <android|ios> [device-udid]
#
# Exits non-zero if any flow fails. Individual flow failures don't stop the run —
# every flow gets a chance to report its own result, mirroring the web suite's
# `npm run all` summary.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <android|ios> [device-udid]" >&2
  exit 1
fi

PLATFORM="$1"
EXPLICIT_UDID="${2:-}"

# Flows are ordered by the app state they require, NOT alphabetically. Only login.yaml starts from
# `clearState: true`; send-message/call-smoke/logout all assume an already signed-in session, and
# logout ends signed out. A plain `find | sort` yields call-smoke, full, login, logout,
# send-message — which runs call-smoke before any sign-in and send-message after logout, so four of
# the five flows failed on a healthy app. full.yaml goes last because it re-runs the whole journey
# from a cleared state, which would otherwise sign the earlier flows out from under themselves.
# today runs before pause (a lingering mid-failure pause would starve today's recompute), and both
# before the messaging/call flows so a paused account can never be what a call failure means.
ORDER=(login.yaml today.yaml activity.yaml connections.yaml subscription.yaml pause.yaml send-message.yaml call-smoke.yaml logout.yaml full.yaml)

declare -a FLOWS=()
for name in "${ORDER[@]}"; do
  path="${SCRIPT_DIR}/flows/${name}"
  if [[ -f "$path" ]]; then
    FLOWS+=("$path")
  else
    echo "error: ordered flow '${name}' is missing from ${SCRIPT_DIR}/flows" >&2
    exit 1
  fi
done

# Any flow added to flows/ but not placed in ORDER above runs last, alphabetically. Appending it
# rather than ignoring it keeps a new flow from being silently skipped; the warning is the prompt to
# give it an explicit position once its state requirements are known.
while IFS= read -r path; do
  name="$(basename "$path")"
  for known in "${ORDER[@]}"; do
    [[ "$name" == "$known" ]] && continue 2
  done
  echo "warning: ${name} is not in ORDER — appending it last; add it to ORDER in $0 to pin its position" >&2
  FLOWS+=("$path")
done < <(find "${SCRIPT_DIR}/flows" -maxdepth 1 -name '*.yaml' | sort)

declare -a RESULTS=()
FAILED=0

for flow in "${FLOWS[@]}"; do
  name="$(basename "$flow")"
  echo ""
  echo "==================== ${name} ===================="
  if "${SCRIPT_DIR}/run-features.sh" "$flow" "$PLATFORM" "$EXPLICIT_UDID"; then
    RESULTS+=("PASS  ${name}")
  else
    RESULTS+=("FAIL  ${name}")
    FAILED=1
  fi
done

echo ""
echo "==================== summary ===================="
for line in "${RESULTS[@]}"; do
  echo "$line"
done

exit "$FAILED"
