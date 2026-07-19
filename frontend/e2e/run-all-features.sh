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

mapfile -t FLOWS < <(find "${SCRIPT_DIR}/flows" -maxdepth 1 -name '*.yaml' | sort)
if [[ ${#FLOWS[@]} -eq 0 ]]; then
  echo "error: no flows found under ${SCRIPT_DIR}/flows" >&2
  exit 1
fi

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
