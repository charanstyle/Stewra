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
# Both forwards ride the ControlMaster connection defined for `home` in ~/.ssh/config, so this is
# cheap to re-run and safe to run twice: an already-established forward is reported, not duplicated.

set -euo pipefail

HOST=home
REDIS_CONTAINER=stewra-redis-1
PG_LOCAL=5433
REDIS_LOCAL=6379

# `ssh -O check` needs an existing master; open one (or reuse it) before asking about forwards.
ssh -o ControlMaster=auto -o ControlPersist=600 -N -f "$HOST" 2>/dev/null || true

redis_addr=$(ssh "$HOST" "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $REDIS_CONTAINER")
if [ -z "$redis_addr" ]; then
  echo "could not resolve an IP for the $REDIS_CONTAINER container on $HOST" >&2
  exit 1
fi

forward() {
  local local_port="$1" remote="$2" label="$3"
  if ssh -O forward -L "127.0.0.1:${local_port}:${remote}" "$HOST" 2>/dev/null; then
    echo "tunnel up: local ${local_port} -> ${label}"
  elif nc -z 127.0.0.1 "${local_port}" 2>/dev/null; then
    # `ssh -O forward` fails when the forward already exists. That is the desired end state, so it is
    # only an error if nothing is actually listening.
    echo "tunnel already up: local ${local_port} -> ${label}"
  else
    echo "failed to forward local ${local_port} -> ${label}" >&2
    exit 1
  fi
}

forward "$PG_LOCAL" "127.0.0.1:${PG_LOCAL}" "${HOST} postgres"
forward "$REDIS_LOCAL" "${redis_addr}:6379" "${HOST} ${REDIS_CONTAINER}"
