# Adding Stewra to the shared coturn on `home`

Stewra reuses the **coturn already running on the `home` host** (the same one serving TrueTalk and
RankRise). We do **not** stand up a new coturn container. Stewra gets its **own realm** and its **own
`static-auth-secret`**, so a leak or misconfiguration in one app's realm cannot mint credentials for
another.

This is a **one-time, manually reviewed** change to the host's coturn config. Treat it carefully: a
fat-fingered edit takes down calling for three apps at once.

## How Stewra authenticates to TURN

The backend (`turnCredentialsService`) mints short-lived credentials in coturn's `use-auth-secret`
(RFC 5766 REST) mode:

```
username   = "<unix-expiry>:<userId>"
credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
```

`TURN_SECRET` is the shared static-auth-secret — known only to this backend and coturn, never sent to
clients. Clients receive only the ephemeral `username`/`credential` pair (valid for
`TURN_CRED_TTL_SECONDS`, default 3600s). Calls **force-relay** (no public STUN), so a broken TURN
surfaces as a failed call in the loopback test rather than a silent NAT-traversal failure.

These four values must agree between coturn and `stewra.env`:

| stewra.env               | coturn                                    |
| ------------------------ | ----------------------------------------- |
| `TURN_SECRET`            | the realm's `static-auth-secret`          |
| `TURN_REALM`             | the realm string                          |
| `TURN_URLS`              | the listening address/port + transport    |
| `TURN_CRED_TTL_SECONDS`  | (client-side only; ≤ coturn's own max)    |

## 1. Generate a Stewra-only secret

On `home`:

```bash
openssl rand -hex 32
```

Put it in `/media/WDHD/docker/stewra/stewra.env` (mode 600, gitignored) as `TURN_SECRET=<value>` and set
`CALLS_ENABLED=true` plus:

```
TURN_REALM=stewra.com
TURN_URLS=turns:turn.stewra.com:5349?transport=tcp
TURN_CRED_TTL_SECONDS=3600
```

`TURN_URLS` is comma-separated if you offer more than one (e.g. a `turn:…:3478` UDP entry alongside the
TLS `turns:…:5349`). Reuse the **existing** TLS listener/cert on `5349` that TrueTalk/RankRise already
use — Stewra does not add ports.

## 2. Add the Stewra realm to coturn

coturn supports multiple realms with per-realm secrets via `use-auth-secret` + realm-scoped secret
lines. Edit the coturn config on `home` (typically `/etc/turnserver.conf`, or the compose-mounted
config if coturn runs in a container). Alongside the existing TrueTalk/RankRise realm lines, add:

```conf
# --- Stewra realm (added <date>) ---
realm=stewra.com
# Per-realm static secret used only by Stewra's backend to mint ephemeral REST credentials.
static-auth-secret=<the value from step 1>
```

If the running coturn uses the single-realm `static-auth-secret` form and you need true per-app secret
isolation, prefer coturn's database/`userdb` or `secret` table with a realm column, or run the realms
with `--use-auth-secret` and distinct `static-auth-secret` blocks per realm as supported by your coturn
version. **Match whatever pattern TrueTalk/RankRise already use on this host** — do not restructure the
shared file. TLS (`5349`), `cert`/`pkey`, `min-port`/`max-port` relay range, and `external-ip` are
shared and unchanged.

## 3. Validate BEFORE reloading

```bash
# Syntax/sanity check without disrupting live calls:
turnadmin -C /etc/turnserver.conf 2>/dev/null || true   # if available on this build
sudo turnserver -c /etc/turnserver.conf --check-config   # dry run where supported
```

Then reload (graceful; existing calls survive a HUP on most builds):

```bash
sudo systemctl reload coturn        # host service
# or, if containerized:
docker compose -f <coturn-compose>.yml restart coturn
```

## 4. Loopback verification (proves realm + secret + relay)

With `CALLS_ENABLED=true` and the stack redeployed:

1. `GET /api/calls/turn-credentials` (authenticated) returns `iceServers` with a `username` of the form
   `<expiry>:<userId>` and a base64 `credential`.
2. In one browser, open the website, start a 1:1 audio call to a second logged-in user (or use the
   single-browser two-`RTCPeerConnection` loopback from the plan's verification section). With
   `iceTransportPolicy: 'relay'` the ICE candidates must be **relay** type and the connection must reach
   `connected`. If it stalls at `checking`, the realm/secret disagree or the relay port range is blocked.

## Rollback

Remove the Stewra realm/secret lines you added, reload coturn, and set `CALLS_ENABLED=false` in
`stewra.env` (Stewra's `/calls` routes then 503 and no credentials are minted). TrueTalk and RankRise are
untouched because their realm lines and secrets were never modified.
