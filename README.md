# Stewra — Milestone 0

A trust-first personal assistant. M0 establishes the **two-plane architecture** — a deterministic
**control plane** (vault, policy, append-only audit, broker) and an untrusted, sandboxed **agent
runtime** that can only obtain data by asking the broker — plus auth, an append-only audit log, a
vault helper, and a **containment test** that proves the agent cannot reach credentials/DB/network
directly. See `build-plan.md` and `memory-and-learning.md` for the product spec.

## Layout

```
packages/shared-types   @stewra/shared-types — the API + broker + audit contracts
packages/agent-runtime  @stewra/agent-runtime — UNTRUSTED; deps = only shared-types
backend                 the monolith: control-plane/ (trusted) + agent-host/ + http
website                 thin Next.js shell: login + activity feed
```

## Dev database (remote Postgres via SSH tunnel)

There is no local Docker on the dev machine. The database is an isolated `stewra` DB + role on the
shared Postgres container on the host `stewra-server` (`/srv/docker`, bound to `127.0.0.1:5433`).

```bash
npm run tunnel        # opens local 5433 -> stewra-server:127.0.0.1:5433 (background)
cp .env.example backend/.env   # then fill DATABASE_URL / JWT_SECRET / VAULT_KEY
```

## Run it end-to-end

```bash
npm install                 # workspaces
npm run build:types         # build @stewra/shared-types -> dist
npm run db:migrate          # apply migrations (001 users, 002 append-only audit, 003 connections)
npm run dev:backend         # API on :3001
# in another shell:
curl localhost:3001/health
npm test                    # containment + auth integration tests
npm run boundaries          # dependency-cruiser: agent-runtime boundary is clean
npm run dev:web             # website on :3000 (login + /activity)
```

## Append-only audit log

The `audit_log` table is enforced append-only by a DB trigger, with exactly one exception: migration
`047_audit_log_erasure` permits clearing `user_id` (and nothing else) so a user can actually be
deleted. Before it, `ON DELETE SET NULL` was an UPDATE, the trigger refused every UPDATE, and no user
who had ever logged in could be removed.

In production, `deploy/audit-log-revoke.sql` adds the DB-privilege half. It hands the table to a
NOLOGIN role so the app role stops owning it — Postgres does not honour `REVOKE` against an owner,
which is why the line this README carried for months was never actually runnable. Run it **after**
migrations; it asserts its own result and is safe to re-run. A future migration touching `audit_log`
will need ownership handed back first — the recipe is in the file's header.

## Production

`docker-compose.prod.yml` is the deploy artifact for `/srv/docker/stewra/` on `stewra-server`. It
brings up `backend`, `website` and `redis`, and reuses the existing shared `postgres` container.
coturn is the one piece that still runs on `home` (the router's relay port-forward points there) —
see `docker-compose.coturn.yml`. Deploy from the host, not the dev machine.

It is applied and serving https://www.stewra.com. `curl https://www.stewra.com/api/health` returning
`{"success":true,"data":{"status":"ok"}}` is the quickest check that the stack is up.
