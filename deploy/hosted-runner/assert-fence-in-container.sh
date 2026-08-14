#!/usr/bin/env bash
#
# Assert the egress fence FROM INSIDE a live runner container — the view that actually matters.
# `assert-fence.sh` proves the iptables rules exist; this proves they bite: it finds the container
# on the runner network and makes real TCP connections from within it.
#
#   bash deploy/hosted-runner/assert-fence-in-container.sh /path/to/stewra.env
#
# Runs on the provisioner host (needs the docker CLI and a runner container currently up — provision
# one via POST /runner/hosted first). The env file argument is only read for DATABASE_URL, to learn
# which port the shared Postgres listens on.
#
# Probe targets are derived from the host's live state, never hardcoded, and every "must be blocked"
# target is a REAL listening service — a probe to a dead address times out with or without a fence
# and would prove nothing:
#
#   * api.github.com:443            -> open      (workspaces must still clone)
#   * this host's LAN address, sshd -> blocked   (hostname -I)
#   * this host's tailnet Postgres  -> blocked   (tailscale ip -4; port from DATABASE_URL)
#   * the runner bridge gateway     -> blocked   (the container's own routed gateway)
#
# The link-local/metadata range is deliberately NOT probed: nothing listens there on a home server,
# so its DROP rule is only assertable at the rules level — assert-fence.sh covers that.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./network.env
. "$HERE/network.env"

ENV_FILE=${1:?usage: $0 /path/to/stewra.env (read only for DATABASE_URL)}

c=$(docker ps --filter "network=$NETWORK_NAME" --format '{{.Names}}' | head -1)
[ -n "$c" ] || { echo "no live runner container on $NETWORK_NAME — provision one first" >&2; exit 1; }
echo "container: $c"

lan_ip=$(hostname -I | awk '{print $1}')
tailnet_ip=$(tailscale ip -4 2>/dev/null || ip -4 -o addr show tailscale0 | awk '{print $4}' | cut -d/ -f1)
# The network's IPAM config stores only the subnet, so ask the container itself what its gateway
# is — that is the address its traffic actually routes through.
gateway_ip=$(docker inspect "$c" --format "{{(index .NetworkSettings.Networks \"$NETWORK_NAME\").Gateway}}")
pg_port=$(grep '^DATABASE_URL=' "$ENV_FILE" | sed -E 's#.*@[^:/]+:([0-9]+)/.*#\1#')
for v in lan_ip tailnet_ip gateway_ip pg_port; do
  [ -n "${!v}" ] || { echo "could not derive $v" >&2; exit 1; }
done
echo "derived: lan=$lan_ip tailnet=$tailnet_ip gateway=$gateway_ip pg_port=$pg_port"

probe() { # name host port expect(open|blocked)
  local name=$1 host=$2 port=$3 expect=$4 out
  # node is guaranteed present in the runner image; connect -> open, timeout/refusal -> blocked.
  out=$(docker exec "$c" node -e "
    const s = require('net').connect({host: '$host', port: $port, timeout: 4000});
    s.on('connect', () => { console.log('open'); process.exit(0); });
    s.on('timeout', () => { console.log('blocked'); process.exit(0); });
    s.on('error', () => { console.log('blocked'); process.exit(0); });
  ")
  if [ "$out" = "$expect" ]; then
    echo "  PASS  $name ($host:$port -> $out)"
  else
    echo "  FAIL  $name ($host:$port -> $out, wanted $expect)"
    fail=1
  fi
}

fail=0
probe 'public internet'          api.github.com  443        open
probe 'LAN host sshd'            "$lan_ip"       22         blocked
probe 'tailnet shared postgres'  "$tailnet_ip"   "$pg_port" blocked
probe 'runner bridge gateway'    "$gateway_ip"   22         blocked
[ "$fail" = 0 ] && echo 'FENCE-ASSERT-OK' || { echo 'FENCE-ASSERT-FAILED' >&2; exit 1; }
