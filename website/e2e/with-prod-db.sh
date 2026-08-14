#!/usr/bin/env bash
#
# with-prod-db.sh — run a command with E2E_DATABASE_URL set, so the suites that provision their own
# preconditions actually run instead of skipping.
#
#   ./with-prod-db.sh                       # the whole main suite
#   ./with-prod-db.sh npx playwright test tests/today.spec.ts
#
# Why this exists: 16 of the main suite's skips are one missing variable. `.env.e2e` is TRACKED in
# git (owner decision 2026-08-13 — it holds only QA-account credentials) and its own header forbids
# putting a production secret in it, so the URL cannot live in the file the rest of the config lives
# in. Before this script that meant hand-exporting a password-bearing URL on every run, which is
# both easy to get wrong and easy to leak into a shell history. Here the secret is read from the
# server at run time, used, and never written down.
#
# What it does NOT do is guess. Every precondition is asserted and a failure stops the run:
#
#   - the deploy host is reachable and `stewra.env` has a DATABASE_URL;
#   - that URL points at the in-cluster `postgres:5432`, i.e. it is the shape this rewrite knows how
#     to translate — if the deploy ever moves the DB, the rewrite is wrong and must be re-read, not
#     silently applied to an address it no longer understands;
#   - the tunnel is up AND the database answers a query through it. `nc -z`-style "something is
#     listening" proves nothing about an ssh forward whose far end has moved — the same trap
#     scripts/tunnel.sh documents at length, which is why the probe is a real SELECT.
#
# There is deliberately no fallback: no local database, no "skip the seeding and carry on". A run
# that cannot reach the real store must fail here, loudly, rather than turn back into the 16 silent
# skips this script exists to remove.
#
# The URL is never echoed. Do not add a debug print — it carries the production Postgres password.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

# Kept in step with scripts/tunnel.sh, which owns the forward this script rides.
HOST=stewra-server
SERVER_ENV=/srv/docker/stewra/stewra.env
PG_LOCAL=5433
REMOTE_PG=@postgres:5432

die() { echo "error: $*" >&2; exit 1; }

# --- 1. the forward -----------------------------------------------------------
# Idempotent and safe to re-run twice (see scripts/tunnel.sh); it re-points a stale redis forward
# and reports an established one rather than duplicating it.
echo "==> Ensuring the ssh tunnel to ${HOST} is up"
bash "${REPO_ROOT}/scripts/tunnel.sh" >/dev/null || die "scripts/tunnel.sh failed — fix the tunnel before running the seeded suites"

# --- 2. the URL ---------------------------------------------------------------
echo "==> Reading DATABASE_URL from ${HOST}:${SERVER_ENV}"
remote_url="$(ssh "$HOST" "grep '^DATABASE_URL=' ${SERVER_ENV} | cut -d= -f2-")" \
  || die "could not read ${SERVER_ENV} on ${HOST}"
[[ -n "$remote_url" ]] || die "${SERVER_ENV} on ${HOST} has no DATABASE_URL line"
[[ "$remote_url" == *"${REMOTE_PG}"* ]] \
  || die "the server's DATABASE_URL does not point at '${REMOTE_PG#@}' — this script's rewrite to the local forward is no longer correct for that deploy; re-read it rather than assuming"

export E2E_DATABASE_URL="${remote_url/${REMOTE_PG}/@127.0.0.1:${PG_LOCAL}}"

# --- 3. prove the database answers through the forward ------------------------
# A listening local port says nothing about the far end. Ask Postgres a question instead, using the
# `pg` this package already depends on and the same connection settings seed.mjs uses. `node --eval`
# resolves bare specifiers against the CWD, so this has to run from the package, not the caller's
# directory — which is also where the test command belongs.
cd "$HERE"
echo "==> Probing the database through 127.0.0.1:${PG_LOCAL}"
node --input-type=module -e '
  import pg from "pg";
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await c.connect();
  const r = await c.query("select current_database() as db");
  await c.end();
  console.error(`    connected to ${r.rows[0].db}`);
' || die "the database did not answer through the tunnel — the forward is up but its far end is not (restart it: npm run tunnel)"

# --- 4. run ------------------------------------------------------------------
if [[ "$#" -eq 0 ]]; then
  set -- npx playwright test
fi
echo "==> E2E_DATABASE_URL is set for: $*"
exec "$@"
