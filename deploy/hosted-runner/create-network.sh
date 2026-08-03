#!/usr/bin/env bash
#
# Create the isolated Docker network that hosted-runner containers live on.
#
# Run ON the deploy host, once, BEFORE the provisioner is started for the first time:
#   sudo bash deploy/hosted-runner/create-network.sh
#
# Two properties this network has that the default bridge does not:
#
#   * A FIXED subnet, read from network.env. The egress firewall rules in iptables-egress.sh match on
#     it by source address, so it cannot be left to Docker's automatic pool — a network that got a
#     different range on the next `docker network create` would silently stop being firewalled.
#   * enable_icc=false. Runner containers belong to DIFFERENT USERS. Without this they could reach
#     each other over the bridge; with it, the only thing a runner can talk to is the outside world
#     (minus everything iptables-egress.sh denies).
#
# Re-running is safe: an existing network with the right subnet is reported and left alone, and one
# with the WRONG subnet is a loud failure rather than a silent mismatch with the firewall rules.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./network.env
. "$HERE/network.env"

for required in RUNNER_SUBNET RUNNER_NETWORK_NAME RUNNER_BRIDGE; do
  if [ -z "${!required}" ]; then
    echo "$required is empty in $HERE/network.env — refusing to create a half-defined network" >&2
    exit 1
  fi
done

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not on PATH — run this on the deploy host" >&2
  exit 1
fi

if docker network inspect "$RUNNER_NETWORK_NAME" >/dev/null 2>&1; then
  existing=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$RUNNER_NETWORK_NAME")
  if [ "$existing" != "$RUNNER_SUBNET" ]; then
    echo "network $RUNNER_NETWORK_NAME already exists with subnet $existing, expected $RUNNER_SUBNET." >&2
    echo "The rules in iptables-egress.sh match on $RUNNER_SUBNET and would NOT cover it." >&2
    echo "Stop every runner container, 'docker network rm $RUNNER_NETWORK_NAME', then re-run this." >&2
    exit 1
  fi
  echo "network $RUNNER_NETWORK_NAME already exists with subnet $RUNNER_SUBNET — nothing to do"
  exit 0
fi

docker network create \
  --driver bridge \
  --subnet "$RUNNER_SUBNET" \
  --opt com.docker.network.bridge.enable_icc=false \
  --opt com.docker.network.bridge.name="$RUNNER_BRIDGE" \
  "$RUNNER_NETWORK_NAME"

echo "created network $RUNNER_NETWORK_NAME ($RUNNER_SUBNET, icc off, bridge $RUNNER_BRIDGE)"
echo "next: sudo bash $HERE/iptables-egress.sh"
