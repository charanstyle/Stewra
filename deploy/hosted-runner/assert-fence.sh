#!/usr/bin/env bash
#
# Assert the hosted-runner egress fence is actually in place. Exits non-zero when it is not.
#
#   sudo bash deploy/hosted-runner/assert-fence.sh
#
# This exists because "the fence is up" and "the script ran without error" were not the same claim.
# `iptables-egress.sh` printed "(none — something is wrong)" and then exited 0, so a host whose rules
# had been flushed reported success to anything checking its exit code. That is the same failure shape
# the tunnel script was fixed for: not a broken thing, but a broken thing that says it is fine.
#
# It is deliberately a separate, side-effect-free script rather than a flag on the applier, so it can
# be run by three different callers that must not be able to disagree:
#
#   * iptables-egress.sh, at the end of its own run — it cannot report success without passing this.
#   * stewra-runner-fence.service, as ExecStartPost — a boot where Docker rebuilt DOCKER-USER and the
#     rules did not land leaves the unit FAILED and visible to `systemctl --failed`, instead of
#     silently active with an unfenced network.
#   * an operator or smoke driver, at any time, to answer "is this host fenced right now?"
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./network.env
. "$HERE/network.env"

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (iptables is root-only) — try: sudo bash $0" >&2
  exit 1
fi

missing=0

require_rule() {
  local chain="$1"
  shift
  if iptables -C "$chain" "$@" 2>/dev/null; then
    echo "  ok: $chain $*"
  else
    echo "  MISSING: $chain $*" >&2
    missing=$((missing + 1))
  fi
}

if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
  echo "UNFENCED: the DOCKER-USER chain does not exist — Docker is not running, so the forward" >&2
  echo "rules cannot be present. Runner containers on this host are not fenced." >&2
  exit 1
fi

echo "checking the fence for $RUNNER_SUBNET:"

for destination in $RUNNER_DENY_DESTINATIONS; do
  require_rule DOCKER-USER -s "$RUNNER_SUBNET" -d "$destination" -j DROP
done

require_rule INPUT -s "$RUNNER_SUBNET" -m conntrack --ctstate NEW -j DROP

# A v6-enabled runner network with only v4 rules is unfenced, and the applier refuses to write rules
# for one. Re-checked here so the state cannot drift after the rules were applied — someone can enable
# IPv6 on the network long after the fence went up.
if docker network inspect "$RUNNER_NETWORK_NAME" -f '{{.EnableIPv6}}' 2>/dev/null | grep -qx true; then
  echo "  UNFENCED: $RUNNER_NETWORK_NAME has IPv6 enabled and only IPv4 rules exist." >&2
  missing=$((missing + 1))
fi

if [ "$missing" -ne 0 ]; then
  echo >&2
  echo "UNFENCED: $missing rule(s) absent. Runner containers can reach private space." >&2
  echo "Re-apply with: sudo bash $HERE/iptables-egress.sh" >&2
  exit 1
fi

echo "fence intact."
