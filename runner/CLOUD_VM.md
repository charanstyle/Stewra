# Running the Stewra Runner on a cloud VM

The Stewra Runner is "one binary, any host." The same process you run on a laptop (pair → hold a socket →
host coding sessions) also runs headless on a VM you own. The only difference is **where the code comes
from**: on a laptop the runner uses repos already on disk; on a VM it **clones** them. Everything downstream
— per-session git worktrees, streamed output, permission prompts, auto-commit, push, and PRs — is identical.

Nothing about this needs an inbound port. The runner dials **out** to Stewra and holds the socket, so it
works behind any firewall or NAT, exactly like the laptop runner.

## The one rule: credentials live on the VM, never on Stewra

The runner clones, pushes, and opens PRs with **the machine's own git and `gh` credentials**. Stewra never
receives, stores, or forwards a git token — the same invariant the laptop runner enforces for push/PR. Your
job when provisioning a VM is to give **that machine** the credentials it needs; Stewra only ever sees the
revocable device token from pairing.

## 1. Build the image

Build from the **repo root** (the image needs the `@stewra/shared-types` workspace package):

```bash
docker build -f runner/Dockerfile -t stewra-runner .
```

## 2. Give the VM its credentials

Pick whichever fits your setup — all keep the credential on the VM:

**GitHub over HTTPS (token) — simplest.** Provide a token with `repo` scope as `GH_TOKEN`. `gh` uses it for
PRs directly; wire git's HTTPS auth to `gh` so clone/push use the same token:

```bash
# one-time, into the mounted home volume, so it persists:
docker run --rm -it -e GH_TOKEN=ghp_xxx -v stewra-runner-home:/home/runner \
  --entrypoint gh stewra-runner auth setup-git
```

**SSH deploy key.** Mount a read/write deploy key and use SSH clone URLs (`git@github.com:owner/repo.git`):

```bash
-v /path/to/id_ed25519:/home/runner/.ssh/id_ed25519:ro
```

**Harness provider auth** is separate and also the VM's own: `claude` (Claude Code subscription/login),
`codex login`, or `GEMINI_API_KEY` for Gemini. Mount the relevant config dir (e.g. `~/.claude`) or set the
provider env var. A harness whose auth is missing simply reports unavailable — it never blocks the runner.

## 3. Pair once, then run

Mint a pairing code in the Stewra web app (Runners → add machine), then:

```bash
# Pair — writes the device token into the home volume so it survives restarts.
docker run --rm \
  -e STEWRA_API_URL=https://www.stewra.com \
  -v stewra-runner-home:/home/runner \
  stewra-runner pair <code>

# Run — clone mode, hosting sessions until stopped.
docker run -d --name stewra-runner --restart unless-stopped \
  -e STEWRA_API_URL=https://www.stewra.com \
  -e GH_TOKEN=ghp_xxx \
  -e STEWRA_RUNNER_CLONE_REPOS="https://github.com/you/repo-a.git https://github.com/you/repo-b.git" \
  -v stewra-runner-home:/home/runner \
  -v stewra-runner-data:/data \
  stewra-runner run
```

The machine appears **online** in the web app with its cloned repos as selectable workspaces. Revoke it there
at any time — the runner wipes its token and exits.

### docker-compose

```yaml
services:
  stewra-runner:
    build: { context: ., dockerfile: runner/Dockerfile }
    restart: unless-stopped
    command: ["run"]
    environment:
      STEWRA_API_URL: https://www.stewra.com
      GH_TOKEN: ${GH_TOKEN}
      STEWRA_RUNNER_CLONE_REPOS: "https://github.com/you/repo-a.git https://github.com/you/repo-b.git"
      STEWRA_RUNNER_DEVICE_NAME: prod-runner-1
    volumes:
      - stewra-runner-home:/home/runner   # device token + provider auth
      - stewra-runner-data:/data          # cloned repos (workspace root)
volumes:
  stewra-runner-home:
  stewra-runner-data:
```

Pair first with a one-off `docker compose run --rm stewra-runner pair <code>`, then `docker compose up -d`.

## Configuration reference

| Env var | Required | Default | Meaning |
| --- | --- | --- | --- |
| `STEWRA_API_URL` | yes | — | Stewra origin, e.g. `https://www.stewra.com`. Fail-loud if unset. |
| `STEWRA_API_PREFIX` | no | `/api` | Backend mount prefix (REST + Socket.IO). Set `""` for a bare backend. |
| `STEWRA_RUNNER_WORKSPACE_MODE` | no | `clone` (in image) | `clone` for a VM; `local` to use on-disk dirs. |
| `STEWRA_RUNNER_CLONE_REPOS` | yes (clone) | — | Whitespace/comma-separated git URLs to clone. |
| `STEWRA_RUNNER_WORKSPACE_ROOT` | no | `/data/workspaces` (in image) | Where clones live. Mount it as a volume to persist. |
| `STEWRA_RUNNER_DEVICE_NAME` | no | hostname | How this machine is labeled in the web app. |
| `GH_TOKEN` / `GITHUB_TOKEN` | for private repos / PRs | — | GitHub token used by `gh` and (via `gh auth setup-git`) by git. |

## Persistence & security

- **Volumes.** `/home/runner` holds the device token (`~/.stewra-runner/device-token`) and provider auth;
  `/data` holds the clones. Keep both so a restart re-pairs from the saved token and reuses existing clones.
- **Blast radius.** Every session runs in its own git worktree on a `stewra/run/<id>` branch cut from the
  clone's base commit — an agent's edits never touch the clone's checked-out branch, only a reviewable branch
  you push or discard.
- **Revocation.** The device token is per-machine and revocable from the web app; revoking drops the runner
  immediately. It is never your Stewra login.
- **Non-root.** The container runs as an unprivileged user.
