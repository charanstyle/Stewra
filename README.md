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
shared Postgres container on the host `home` (`/media/WDHD/docker`, bound to `127.0.0.1:5433`).

```bash
npm run tunnel        # opens local 5433 -> home:127.0.0.1:5433 (background)
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

The `audit_log` table is enforced append-only by a DB trigger that rejects UPDATE/DELETE. In
production, additionally `REVOKE UPDATE, DELETE ON audit_log FROM <app_role>`.

## Production

`docker-compose.prod.yml` is the deploy artifact for `/media/WDHD/docker/stewra/` on the host. It
reuses the existing shared `postgres` container. Deploy from the host, not the dev machine. Not yet
applied.
