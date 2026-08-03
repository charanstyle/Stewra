#!/usr/bin/env bash
#
# Bring up the SSH tunnels that local development and the backend test suite need.
#
#   local 127.0.0.1:5433 -> home:127.0.0.1:5433   (the `postgres` container's published port)
#   local 127.0.0.1:6379 -> home:<container-ip>:6379  (the `stewra-redis-1` container)
#
# Postgres publishes a host port on the server, so its forward is a fixed address. Redis does NOT —
# `stewra-redis-1` only exposes 6379 on the docker network — so its address has to be resolved at
# tunnel time. That is why this is a script and not a one-liner in package.json: hardcoding a docker
# network IP would silently point at whatever container inherits it after a restart.
#
# Because that address is resolved per run, the redis forward can go STALE: restart the container and
# it comes back on a different docker IP, while the existing forward still points at the old one. The
# local port keeps accepting connections — ssh only discovers the far end is gone once it tries to
# connect — so "something is listening" proves nothing. This script therefore PROBES redis through the
# forward and re-points it when the probe fails. An earlier version checked only `nc -z`, and reported
# "tunnel already up" for a forward that had been dead for hours; the backend suite failed 17 tests
# with connection resets while the tunnel claimed to be healthy.
#
# The ControlMaster for `home` is SHARED with other projects on this machine (TrueTalk forwards its
# redis over the same connection). So this script never runs `ssh -O exit` to clear a bad forward —
# that would drop someone else's tunnel too. It cancels the one forward it owns, using the remote
# address it recorded last run, and fails loudly if it cannot.
#
# Both forwards ride the ControlMaster connection defined for `home` in ~/.ssh/config, so this is
# cheap to re-run and safe to run twice: an already-established forward is reported, not duplicated.
#
# A launchd agent (scripts/com.stewra.tunnel.plist) re-runs this every 5 minutes so the master never
# hits its ControlPersist idle timeout. It runs a COPY at ~/Library/Application Support/Stewra/
# (TCC blocks launchd from this exFAT volume) — after editing this file, refresh the copy:
#   cp scripts/tunnel.sh ~/Library/Application\ Support/Stewra/tunnel.sh

set -euo pipefail

HOST=home
REDIS_CONTAINER=stewra-redis-1
PG_LOCAL=5433
REDIS_LOCAL=6379

# Where the redis forward's remote address is remembered between runs. Cancelling a forward requires
# the address it was CREATED with, which is no longer discoverable once the container has moved.
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/stewra"
STATE_FILE="$STATE_DIR/tunnel-redis-remote"

# `ssh -O check` needs an existing master; open one (or reuse it) before asking about forwards.
ssh -o ControlMaster=auto -o ControlPersist=600 -N -f "$HOST" 2>/dev/null || true

redis_addr=$(ssh "$HOST" "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $REDIS_CONTAINER")
if [ -z "$redis_addr" ]; then
  echo "could not resolve an IP for the $REDIS_CONTAINER container on $HOST" >&2
  exit 1
fi
redis_remote="${redis_addr}:6379"

# Does redis actually answer through the local forward? A live forward replies +PONG; a stale one is
# closed by ssh the moment it tries the dead far end, so the read gets EOF instead. Uses bash's
# /dev/tcp rather than nc or redis-cli, so the launchd agent needs nothing on its PATH.
redis_speaks() {
  local reply=''
  exec 3<>"/dev/tcp/127.0.0.1/${REDIS_LOCAL}" 2>/dev/null || return 1
  printf 'PING\r\n' >&3 2>/dev/null || { exec 3<&- 3>&- 2>/dev/null; return 1; }
  IFS= read -r -t 3 reply <&3 2>/dev/null || reply=''
  exec 3<&- 3>&- 2>/dev/null || true
  case "$reply" in
    +PONG*) return 0 ;;
    *) return 1 ;;
  esac
}

record_redis_remote() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$redis_remote" >"$STATE_FILE"
}

# Fixed-address forwards (postgres): a published host port cannot go stale, so "already listening" is
# a sufficient check here.
forward_fixed() {
  local local_port="$1" remote="$2" label="$3"
  if ssh -O forward -L "127.0.0.1:${local_port}:${remote}" "$HOST" 2>/dev/null; then
    echo "tunnel up: local ${local_port} -> ${label}"
  elif nc -z 127.0.0.1 "${local_port}" 2>/dev/null; then
    # `ssh -O forward` fails when the forward already exists. That is the desired end state.
    echo "tunnel already up: local ${local_port} -> ${label}"
  else
    echo "failed to forward local ${local_port} -> ${label}" >&2
    exit 1
  fi
}

forward_redis() {
  local label="${HOST} ${REDIS_CONTAINER}"

  if ssh -O forward -L "127.0.0.1:${REDIS_LOCAL}:${redis_remote}" "$HOST" 2>/dev/null; then
    record_redis_remote
    echo "tunnel up: local ${REDIS_LOCAL} -> ${label} (${redis_remote})"
    return
  fi

  # A forward already occupies the port. Whether it points anywhere useful is the open question.
  if redis_speaks; then
    record_redis_remote
    echo "tunnel already up: local ${REDIS_LOCAL} -> ${label} (${redis_remote})"
    return
  fi

  echo "local ${REDIS_LOCAL} is forwarded but redis does not answer — the container has moved to ${redis_remote}" >&2

  local previous=''
  [ -f "$STATE_FILE" ] && previous=$(tr -d '[:space:]' <"$STATE_FILE")
  if [ -z "$previous" ]; then
    echo "cannot re-point it: no record of the address this forward was created with ($STATE_FILE)." >&2
    echo "the ssh master is SHARED with other projects, so do not run 'ssh -O exit home' blindly." >&2
    echo "cancel the stale forward by hand once the old address is known, then re-run this script:" >&2
    echo "  ssh -O cancel -L 127.0.0.1:${REDIS_LOCAL}:<old-addr>:6379 ${HOST}" >&2
    exit 1
  fi

  if ! ssh -O cancel -L "127.0.0.1:${REDIS_LOCAL}:${previous}" "$HOST" 2>/dev/null; then
    echo "failed to cancel the stale forward to ${previous}; re-run after checking 'ssh -O check ${HOST}'." >&2
    exit 1
  fi
  if ! ssh -O forward -L "127.0.0.1:${REDIS_LOCAL}:${redis_remote}" "$HOST" 2>/dev/null; then
    echo "cancelled the stale forward to ${previous} but could not establish one to ${redis_remote}." >&2
    exit 1
  fi
  if ! redis_speaks; then
    echo "re-pointed local ${REDIS_LOCAL} to ${redis_remote}, but redis still does not answer." >&2
    exit 1
  fi

  record_redis_remote
  echo "tunnel re-pointed: local ${REDIS_LOCAL} -> ${label} (${previous} -> ${redis_remote})"
}

forward_fixed "$PG_LOCAL" "127.0.0.1:${PG_LOCAL}" "${HOST} postgres"
forward_redis
