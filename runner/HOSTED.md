# Stewra-hosted cloud runners

The cloud-first path: the user clicks "set up cloud runner" and Stewra provisions a hardened
container on its own host. No binary to install, no laptop to keep awake.

This is **not** `CLOUD_VM.md`. That document covers running the runner binary on a VM *you* own, with
*your* credentials, paired like a laptop. This one covers containers **Stewra** creates, owns, and
bills for — a different trust model and a different set of prerequisites.

> **Status:** off by default, and not enabled on any current deploy. `HOSTED_RUNNER_ENABLED=false`
> ships that way deliberately. Standing it up is the four host steps in [Prerequisites](#prerequisites)
> plus a real GitHub App.

## Why the provisioner exists

The provisioner is the **only** process on the host holding the Docker socket, and the backend can
reach it only over the internal `stewra_internal` compose network.

The backend parses untrusted internet input. If it held the socket, one deserialization bug would be
host root. Instead it can ask for *"a container for device `<uuid>`"* and nothing else — the hardened
template (capabilities, memory/CPU/PID limits, mounts, network) lives in `provisioner/src/template.ts`
and **no field of a request can influence it**. The provisioner also rejects any image that is not its
own configured `RUNNER_IMAGE`, so a compromised backend cannot choose what its containers run.

## The credential invariant

**No long-lived user git credential is ever at rest on Stewra.**

`backend/src/services/githubAppService.ts` enforces this structurally rather than by policy: at rest
there is one row per user holding `installation_id` + account login and **no credential** (migration
036). Git access happens through GitHub App installation tokens minted on demand from the App's
private key — ≤1 hour, cached in memory only, handed out per operation. The invariant holds because
the service has nowhere to put a credential.

Harness credentials (e.g. `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code) are a separate story: they are
written into the container by the provisioner via `putCredential`, never stored in the backend's
database.

## Accepted trades

These are deliberate MVP choices, recorded here because the code points at this file for the
reasoning. Each is a thing a reviewer should be able to find rather than rediscover.

### Uninstalls are detected lazily

*Cited by `backend/src/services/githubAppService.ts`.*

There is no GitHub uninstall webhook. When a user removes the App, Stewra finds out at the next token
mint, where GitHub answers `404`; that clears the row and surfaces "reconnect GitHub" in the UI.

**Consequence:** between the uninstall and the next mint, the UI still claims GitHub is connected.
Nothing is leaked — the mint is the only thing that could use the installation, and it is exactly what
fails. **The clean fix is an uninstall webhook.**

### The device token is passed as environment, not a file

*Cited by `backend/src/services/hostedRunnerService.ts`.*

`STEWRA_RUNNER_DEVICE_TOKEN` goes in via the container's environment rather than being written to its
volume. The runner needs it *before* it has touched the volume, and on Stewra's own host
`docker inspect` is root-only — and root could read the volume anyway. So the environment route costs
nothing that the alternative would have saved.

**Consequence:** the token is visible to anything that can already read the Docker API, which is the
provisioner and root. Both are already inside the trust boundary.

### The egress firewall must be installed as a unit, or it does not survive a reboot

*The most important one on this page.*

`deploy/hosted-runner/iptables-egress.sh` is the **entire isolation claim** of the hosted design, and
iptables rules live in kernel memory — applying them by hand fences the host until the next reboot and
no longer.

`deploy/hosted-runner/stewra-runner-fence.service` now ships next to it and closes that. It re-applies
the rules `After=docker.service`, and `PartOf=docker.service` makes systemd re-run it on every Docker
restart — which matters because **Docker rebuilds the DOCKER-USER chain when it starts**, so a
`systemctl restart docker` during a routine upgrade would otherwise leave the host unfenced with
nothing said. That is also why the unit is preferred over `iptables-persistent` alone: a ruleset
restored early in boot is discarded when Docker comes up after it.

Two things now refuse to claim a fence that is not there:

* `deploy/hosted-runner/assert-fence.sh` checks every rule and exits non-zero if any is missing (or if
  IPv6 has since been enabled on the network, which only-IPv4 rules do not cover).
* `iptables-egress.sh` runs that assertion before exiting 0. It previously printed
  *"(none — something is wrong)"* and exited **0**, so a run that inserted nothing looked like success
  to any caller reading the exit code.

The unit runs the assertion as `ExecStartPost`, so a boot where the rules did not land leaves the unit
**failed** and visible to `systemctl --failed`, rather than silently active over an unfenced network.

**Consequence if you skip the install:** after any host reboot, runner containers can reach the LAN,
this host, the shared Postgres and Redis, and every other project's stack, until the script is re-run.
**Until the unit is installed and a reboot has been rehearsed, treat a reboot as an incident.**

**Still unproven here:** nothing in this repo has executed the fence against a real Docker daemon —
this host has no provisioner container and `HOSTED_RUNNER_ENABLED=false`. The unit and the assertion
are written and reviewed, not exercised. Installing them on a host that actually runs runners, then
rebooting it and running `assert-fence.sh`, is what turns that from reviewed into proven.

## Prerequisites

The `provisioner` service sits behind the compose profile `hosted`, so a deploy that has not done
these steps is completely unaffected — a plain `docker compose up -d` never builds, starts, or even
resolves it. On the host, before the first `--profile hosted` up:

```bash
# 1. The isolated network — fixed subnet, enable_icc=false so one user's runner
#    cannot reach another's.
bash deploy/hosted-runner/create-network.sh

# 2. Fence it off everything private. Re-runnable, and it now asserts its own result.
sudo bash deploy/hosted-runner/iptables-egress.sh

# 2b. Make the fence survive reboots and Docker restarts. Skipping this leaves the host fenced
#     only until it next reboots (see above).
sudo cp deploy/hosted-runner/stewra-runner-fence.service /etc/systemd/system/
sudo sed -i "s#@REPO@#$(pwd)#" /etc/systemd/system/stewra-runner-fence.service
sudo systemctl daemon-reload
sudo systemctl enable --now stewra-runner-fence.service

# 3. Build and tag the runner image the provisioner is pinned to.
docker build -f runner/Dockerfile -t stewra-runner:0.1.0 .

# 4. Write provisioner.env — every key required, it refuses to boot without them:
#      PROVISIONER_TOKEN, DOCKER_SOCKET, RUNNER_IMAGE, RUNNER_NETWORK,
#      RUNNER_MEMORY_BYTES, RUNNER_NANO_CPUS, RUNNER_PIDS_LIMIT
#    PROVISIONER_TOKEN must be byte-identical to HOSTED_RUNNER_PROVISIONER_TOKEN in stewra.env.

docker compose -f docker-compose.prod.yml --profile hosted up -d
```

Network identity (subnet, bridge name, deny list) is in `deploy/hosted-runner/network.env`, sourced by
**both** scripts so the network that gets created and the network that gets firewalled cannot drift.

### Backend configuration

Turning it on requires, and refuses to boot without: `RUNNER_ENABLED=true`, a fully configured GitHub
App, and the hosted block. All keys are documented with their reasoning in `.env.example`:

| Key | Notes |
| --- | --- |
| `HOSTED_RUNNER_ENABLED` | `false` by default — its own switch, so enabling a neighbouring feature never starts creating containers |
| `HOSTED_RUNNER_PROVISIONER_URL` | Internal compose name; the provisioner publishes no ports |
| `HOSTED_RUNNER_PROVISIONER_TOKEN` | ≥32 chars, the entire auth story to a process that can create containers |
| `HOSTED_RUNNER_IMAGE` | Sent verbatim, rejected unless it matches the provisioner's own `RUNNER_IMAGE` |
| `HOSTED_RUNNER_API_URL` | The **public** origin. An internal name here produces containers that boot, fail to connect, and look like an image fault |
| `HOSTED_RUNNER_IDLE_STOP_MINUTES` | Stop the container; volumes survive |
| `HOSTED_RUNNER_WAKE_TIMEOUT_SECONDS` | How long a start may take before it is called failed |
| `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_APP_PRIVATE_KEY_BASE64` | All-or-nothing: some-but-not-all refuses to boot |

## API surface

REST only — no client calls these yet, which is why the coverage story below is a driver rather than
a Playwright spec.

**User-facing** (`requireAuth`, most also `verified`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/runner/hosted` | Status: enabled, the runner if any, idle-stop minutes |
| `POST` | `/runner/hosted` | Provision. Body may carry harness credentials |
| `POST` | `/runner/hosted/start` | Wake a stopped container; volumes intact |
| `POST` | `/runner/hosted/stop` | Stop; volumes intact, work recoverable |
| `DELETE` | `/runner/hosted` | Destroy container **and** volumes |
| `PUT` | `/runner/hosted/credentials/:harness` | Rotate one harness credential |

**Runner-facing** (device token, and `requireHostedRunnerDevice` — a *local* device token gets `403`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/runner/hosted/workspaces` | What to clone. Asked at every boot, so adding a repo to the installation reaches the container without a reprovision |
| `POST` | `/runner/git-credentials` | Mint a short-lived installation token for one operation |

## Testing

| Layer | Where | What is real |
| --- | --- | --- |
| Service | `backend/src/tests/hostedRunnerService.test.ts` | Real Postgres, real route table over a real HTTP server, scripted-but-strict GitHub and provisioner that record and assert zero `rejections` |
| Container | `provisioner/src/tests/provisioner.test.ts` | A **real Docker daemon** and real containers |
| End to end | `runner/smoke-hosted-fullstack.mts` | Everything above, joined |

```bash
BASE=https://www.stewra.com/api CLAUDE_CODE_OAUTH_TOKEN=… npx tsx runner/smoke-hosted-fullstack.mts
```

The driver provisions a cloud runner, waits for it to dial back with `claude-code` available, starts a
Claude Code session through Stewra, answers its permission prompts, sends a follow-up prompt mid-run,
cancels a second session, then exercises stop → start → destroy. It **refuses to adopt or destroy a
pre-existing cloud runner** and only tears down what it created.

It also asserts the laptop invariant from the live system: `GET /runner/hosted/workspaces` and
`POST /runner/git-credentials` with a **local** device token must both be `403`. That is currently
proven only against a scripted backend.

**Not covered by anything:** the iptables egress fence. Asserting it needs a shell inside a running
container checking that `169.254.169.254`, the LAN, and the host are all unreachable while a public
host is reachable. Until that exists, the isolation claim is verified by reading the script, not by
running it — and see the reboot trade above.

## Related

- `.env.example` — every key, with the reasoning inline
- `deploy/hosted-runner/` — `create-network.sh`, `iptables-egress.sh`, `network.env`
- `provisioner/src/template.ts` — the hardened container template no request can influence
- `runner/CLOUD_VM.md` — the *other* thing: your own VM, your own credentials
- `TESTING.md` — how to run each suite above
</content>
</invoke>
