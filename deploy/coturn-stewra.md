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

## Production reachability — the two manual steps

The home host sits behind NAT (public IP `38.77.165.20` lives on the router, not the host), and it
also runs a **host firewall (ufw)**. A remote client's packet has to survive both. Neither is done by
the deploy machine.

### 1. Router port-forward (OpenWrt, `192.168.1.1`) — DONE

```
UDP  3481          -> 192.168.1.179:3481
TCP  3481          -> 192.168.1.179:3481
UDP  49202-49250   -> 192.168.1.179:49202-49250
```

Present as `uci` redirects named `UDP 3481` / `TCP 3481` / `UDP 49202 - 49250`. Verify with
`ssh home-router 'uci show firewall | grep 3481'`, and confirm packets actually arrive by watching the
counters move: `nft list ruleset | grep 'dport 3481 counter'`.

### 2. ufw allow on the host — REQUIRED, and easy to miss

`ufw` is enabled on `home` and defaults to deny-inbound, so a correctly forwarded packet is dropped on
arrival unless the port is opened too:

```bash
sudo ufw allow 3481/tcp
sudo ufw allow 3481/udp
sudo ufw allow 49202:49250/udp
```

This is the step that makes coturn look broken when it is not. Everything on-host still works while it
is missing — the container is healthy, it answers STUN on the LAN, and `turnutils_uclient` run inside
the container allocates a relay successfully — because host-local traffic never traverses ufw's INPUT
chain. Only genuinely remote clients are affected, which is exactly the case the tests care about.

The distinguishing signal is on the router: the DNAT counter for the port increments (so the forward
works) while conntrack shows the flow `[UNREPLIED]` with `packets=0` on the reply side (so the host
never answered):

```bash
ssh home-router 'grep dport=3481 /proc/net/nf_conntrack'
# ... SYN_SENT ... dport=3481 packets=1 ... [UNREPLIED] src=192.168.1.179 ... packets=0
```

Until both steps exist, calls only relay for clients on the same LAN as `home`.

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

Telling those two causes apart takes one packet — a STUN Binding Request needs no credentials, so a
reply proves the path is open and the daemon is alive, and silence proves it is not:

```bash
# from OUTSIDE the LAN. A reply on 3478 (TrueTalk, already forwarded) but silence on 3481 is the
# port-forward above still missing, not a coturn or secret problem.
nc -zv -w 5 38.77.165.20 3481        # TCP; coturn also listens here
```

Run the same relay-candidate check the website suite runs — `website/e2e/tests/calls.spec.ts` probes
TURN in `beforeAll` and prints `[call] TURN preflight: NO relay candidates …` when this forward is
absent, so a red call suite says which side is broken instead of only timing out on "Connected".

3. The secret half is checkable on its own, from **inside** the LAN where the forward is not involved.
   coturn ships its own client, so no relay of the port-forward question is needed:

```bash
# username/credential from an authenticated GET /api/calls/turn-credentials (they are ephemeral).
docker exec stewra-coturn turnutils_uclient -v -y -n 1 \
  -p 3481 -u '<expiry>:<userId>' -w '<base64-credential>' 192.168.1.179
```

   `401`/integrity errors mean `TURN_SECRET` and `TURN_STATIC_AUTH_SECRET` disagree — a fault the
   port-forward would not fix. Success looks like `allocate → success`, `Received relay addr:
   38.77.165.20:492xx` (proves `--external-ip` is advertised correctly and the relay range matches
   the table above), then `channel bind → success` and `tot_send_msgs == tot_recv_msgs`.

   **Verified 2026-07-31: this passes end-to-end** — allocate, refresh, 4 channel binds and 4/4
   packets relayed with 0 lost, using a credential minted by the live backend. The secrets therefore
   agree and coturn itself is known-good.

   Note what this check does **not** prove: it runs inside the container, so it never crosses ufw or
   the router. A green result here alongside a dead call from a remote browser is the signature of the
   ufw step above, not of a coturn or credential problem.

## Rollback

```bash
docker compose -f docker-compose.prod.yml stop coturn && docker rm stewra-coturn
```

Set `CALLS_ENABLED=false` in `stewra.env` and redeploy the backend (its `/calls` routes then 503).
RankRise/TrueTalk are unaffected — their coturn, realm, and secret were never modified.
