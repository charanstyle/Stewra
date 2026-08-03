#!/usr/bin/env bash
#
# Fence the hosted-runner network off from everything private, on the deploy host.
#
#   sudo bash deploy/hosted-runner/iptables-egress.sh
#
# WHY NOT AN ALLOWLIST: a coding agent legitimately needs the open internet — npm, PyPI, crates.io,
# GitHub, the model APIs, whatever a user's repo pulls at install time. Enumerating that is hopeless.
# The property that actually matters is the opposite one, and it IS enumerable: a runner container
# must never reach the LAN, this host, the shared Postgres, the Redis, or another project's stack.
# Every one of those lives in private address space, so private space is what gets dropped.
#
# TWO rules, because container traffic takes two different paths through netfilter:
#
#   * FORWARD (via Docker's DOCKER-USER chain, which Docker guarantees is consulted before its own
#     rules and never rewritten by it): runner -> anywhere-else-private. This is the LAN and the
#     other containers' networks.
#   * INPUT: runner -> THIS host. Forwarding rules never see it, because packets addressed to the
#     host are delivered locally rather than forwarded. Dropping NEW connections leaves established
#     ones (the ones the host itself opened) working.
#
# Re-running is safe — every rule is checked before it is inserted.
#
# NOT PERSISTENT ACROSS REBOOT. iptables rules live in kernel memory. See the tail of this script for
# what to do about that; until it is done, a reboot silently unfences every runner.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./network.env
. "$HERE/network.env"

if [ -z "${RUNNER_SUBNET}" ] || [ -z "${RUNNER_DENY_DESTINATIONS}" ]; then
  echo "RUNNER_SUBNET / RUNNER_DENY_DESTINATIONS must be set in $HERE/network.env" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (iptables) — try: sudo bash $0" >&2
  exit 1
fi

if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
  echo "the DOCKER-USER chain does not exist — is Docker installed and started on this host?" >&2
  echo "Docker creates it at startup; without it these rules would not be consulted." >&2
  exit 1
fi

# Insert (not append): DOCKER-USER also carries Docker's own RETURN at the end, and an appended rule
# after it would never be reached.
ensure_rule() {
  local chain="$1"
  shift
  if iptables -C "$chain" "$@" 2>/dev/null; then
    echo "  already present: $chain $*"
  else
    iptables -I "$chain" 1 "$@"
    echo "  inserted: $chain $*"
  fi
}

echo "fencing $RUNNER_SUBNET:"

# 1. Forwarded traffic from a runner into private space — the LAN, the other docker networks, the
#    link-local range (which is where cloud metadata services live), loopback-addressed spoofs.
for destination in $RUNNER_DENY_DESTINATIONS; do
  ensure_rule DOCKER-USER -s "$RUNNER_SUBNET" -d "$destination" -j DROP
done

# 2. Anything a runner addresses to this host directly: the bridge gateway address, the LAN address,
#    a published port on 0.0.0.0. ESTABLISHED/RELATED is untouched, so replies to connections the
#    host itself opened still flow.
ensure_rule INPUT -s "$RUNNER_SUBNET" -m conntrack --ctstate NEW -j DROP

# IPv6: this network is created without an IPv6 subnet, so containers have no v6 address and no v6
# path off the bridge. If IPv6 is ever enabled for it, the equivalent ip6tables rules must be added
# HERE — a v6-enabled runner network with only v4 rules is unfenced.
if docker network inspect "$RUNNER_NETWORK_NAME" -f '{{.EnableIPv6}}' 2>/dev/null | grep -qx true; then
  echo "REFUSING TO CLAIM THIS HOST IS FENCED: $RUNNER_NETWORK_NAME has IPv6 enabled and this" >&2
  echo "script only writes IPv4 rules. Disable IPv6 on the network or add ip6tables rules." >&2
  exit 1
fi

echo
echo "active rules:"
iptables -n -L DOCKER-USER --line-numbers | grep -F "$RUNNER_SUBNET" || echo "  (none — something is wrong)"
iptables -n -L INPUT --line-numbers | grep -F "$RUNNER_SUBNET" || echo "  (none — something is wrong)"

cat <<PERSIST

These rules do NOT survive a reboot. Make them permanent with ONE of:

  * netfilter-persistent (Debian/Ubuntu):
      apt-get install iptables-persistent && netfilter-persistent save
    Re-save after every change to this script.

  * a systemd unit that re-runs this script after docker.service, which is more robust because the
    DOCKER-USER chain is recreated by Docker on start:
      /etc/systemd/system/stewra-runner-fence.service
        [Unit]
        After=docker.service
        Requires=docker.service
        [Service]
        Type=oneshot
        ExecStart=$HERE/iptables-egress.sh
        RemainAfterExit=yes
        [Install]
        WantedBy=multi-user.target

Verify from inside a runner container (all three must behave as stated):
  docker exec <runner> sh -c 'nc -z -w2 <host-lan-ip> 22; echo "host: \$?  (want non-zero)"'
  docker exec <runner> sh -c 'nc -z -w2 <postgres-container-ip> 5432; echo "pg: \$?  (want non-zero)"'
  docker exec <runner> sh -c 'wget -q -O- -T5 https://api.github.com/zen; echo "  github: \$? (want 0)"'
PERSIST
