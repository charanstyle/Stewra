# Stewra TURN — a dedicated coturn instance on `home`

Stewra runs its **own** coturn container (`stewra-coturn`, defined in `docker-compose.prod.yml`). It does
**not** share, and does not modify, the `rankrise-coturn` that also runs on `home`.

## Why a dedicated instance (not a realm on the shared coturn)

`rankrise-coturn` runs in coturn's `use-auth-secret` (TURN REST) mode with a **single global**
`static-auth-secret`. In that mode the ephemeral credential is `username="<expiry>:<userId>"`,
`credential=base64(HMAC-SHA1(secret, username))`, and coturn validates the HMAC against the one global
secret **regardless of realm**. Adding a `realm=stewra.com` line to that instance would therefore force
Stewra to reuse RankRise's secret — no isolation, and a risky edit to a file that fronts three apps.

A separate container gives Stewra its own realm, its own secret, its own ports, and its own relay range,
while RankRise/TrueTalk are never touched.

## How Stewra authenticates to TURN

Same REST scheme, validated by `turnCredentialsService` on the backend and `stewra-coturn`:

```
username   = "<unix-expiry>:<userId>"
credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
```

`TURN_SECRET` (in `stewra.env`, backend side) and `TURN_STATIC_AUTH_SECRET` (in the compose `./.env`,
coturn side) **must be the identical value**. Clients only ever receive the ephemeral username/credential
(TTL `TURN_CRED_TTL_SECONDS`, default 3600s). Calls force-relay, so a broken TURN surfaces as a failed
call, never a silent degrade.

## Port map (distinct from rankrise-coturn's 3478/5349 + relay 49152–49200)

| Purpose            | Stewra port           | rankrise (do not collide) |
| ------------------ | --------------------- | ------------------------- |
| TURN listener      | `3481` (udp + tcp)    | `3478`                    |
| Relay range        | `49202–49250` (udp)   | `49152–49200`             |
| TLS (turns:)       | not enabled (v1)      | `5349`                    |

`network_mode: host` (mirrors rankrise) so relay candidates use the real interface. coturn binds
`listening-ip=relay-ip=192.168.1.179` (the LAN interface where forwarded packets arrive) and advertises
`--external-ip=38.77.165.20` (the public IP) in relay candidates, so remote peers on other networks
connect to the public IP and the router forwards to the host.

## Production reachability — the one manual step (router port-forward)

The home host sits behind NAT (public IP `38.77.165.20` lives on the router, not the host). RankRise's
ports are already forwarded; Stewra's new ports are **not**, so live calls between different networks
require adding this forward on the router (→ `192.168.1.179`):

```
UDP  3481          -> 192.168.1.179:3481
TCP  3481          -> 192.168.1.179:3481
UDP  49202-49250   -> 192.168.1.179:49202-49250
```

Until this exists, calls only relay for clients that are on the same LAN as `home`. This is the sole
piece that cannot be done from the deploy machine.

## Config values

`./.env` (compose-substitution only; gitignored, alongside `VITE_API_BASE_URL`):

```
TURN_STATIC_AUTH_SECRET=<openssl rand -hex 32>
TURN_EXTERNAL_IP=38.77.165.20
```

`stewra.env` (backend runtime; gitignored):

```
CALLS_ENABLED=true
TURN_SECRET=<the SAME value as TURN_STATIC_AUTH_SECRET>
TURN_REALM=stewra.com
TURN_URLS=turn:38.77.165.20:3481?transport=udp,turn:38.77.165.20:3481?transport=tcp
TURN_CRED_TTL_SECONDS=3600
```

Plain `turn:` (not `turns:`) — WebRTC permits `turn:` from an https page, and `turns:` would need a
`turn.stewra.com` certificate. Adding a DNS name + TLS listener on `5350` is a documented hardening
follow-up; the raw public IP is fully functional for real remote users in the meantime.

## Bring up + validate

```bash
cd /media/WDHD/docker/stewra
docker compose -f docker-compose.prod.yml up -d coturn
docker logs stewra-coturn --tail 20        # expect "Relay ... 192.168.1.179" and no bind errors
```

1. `GET /api/calls/turn-credentials` (authenticated) returns `iceServers` with `username` `<expiry>:<uid>`
   and a base64 `credential`, and the `turn:38.77.165.20:3481` URLs.
2. With `iceTransportPolicy: 'relay'`, a 1:1 call (or the single-page two-`RTCPeerConnection` loopback)
   must gather **relay** candidates and reach `connected`. Stalling at `checking` means the port-forward
   is missing or the secret disagrees between `./.env` and `stewra.env`.

## Rollback

```bash
docker compose -f docker-compose.prod.yml stop coturn && docker rm stewra-coturn
```

Set `CALLS_ENABLED=false` in `stewra.env` and redeploy the backend (its `/calls` routes then 503).
RankRise/TrueTalk are unaffected — their coturn, realm, and secret were never modified.
