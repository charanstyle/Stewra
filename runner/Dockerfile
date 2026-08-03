# syntax=docker/dockerfile:1
#
# Stewra Runner — cloud-VM image. The SAME binary as the laptop runner (Phases 1–3), packaged to run
# headless on a user-owned VM in WORKSPACE_MODE=clone: it clones the repos it runs against instead of
# finding them already on disk. No protocol change — it's the same runner on a different host.
#
# Build from the REPO ROOT (it needs the workspace package @stewra/shared-types):
#   docker build -f runner/Dockerfile -t stewra-runner .
#
# The runner uses the MACHINE'S OWN git/gh credentials for clone/push/PR — Stewra never holds a token.
# Supply them (and each harness's provider login) at RUNTIME. See runner/CLOUD_VM.md.

# ── build stage: compile @stewra/shared-types + the runner from the monorepo ──────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Manifests first so `npm ci` caches until a dependency actually changes. `tsconfig.base.json` comes with
# them because every workspace's tsconfig extends it — without it `tsc` fails with TS5083 at build time.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY runner/package.json runner/
RUN npm ci
# Sources, then build the workspace dep before the runner that imports it.
COPY packages/shared-types packages/shared-types
COPY runner runner
RUN npm run build -w @stewra/shared-types \
 && npm run build -w @stewra/runner \
 && npm prune --omit=dev

# ── runtime stage: node + git + gh, and nothing else ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
# git: clone / worktree / push.  gh: open PRs.  openssh-client: SSH remotes / deploy keys.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Copy the built artifacts + pruned production node_modules (which includes the shared-types workspace link).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=build /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build /app/runner/package.json ./runner/package.json
COPY --from=build /app/runner/dist ./runner/dist

# A non-root user. `/data` (clones) and the home dir (device token at ~/.stewra-runner/device-token) are
# volumes so a restart re-pairs from the saved token and reuses existing clones instead of starting cold.
RUN useradd -m -u 10001 runner \
 && mkdir -p /data/workspaces /home/runner/.stewra-runner \
 && chown -R runner:runner /data /home/runner \
 # COPY preserves the source tree's permissions, and a developer checkout made under a restrictive umask
 # is owner-only. That lands root-owned, mode-600 files in /app, which the non-root `runner` user cannot
 # read — the process dies on its first import. `a+rX` grants read to everyone and execute only where it
 # already applies (directories and real executables), so the app stays runnable without becoming writable.
 && chmod -R a+rX /app
USER runner

ENV NODE_ENV=production \
    STEWRA_RUNNER_WORKSPACE_MODE=clone \
    STEWRA_RUNNER_WORKSPACE_ROOT=/data/workspaces
VOLUME ["/data", "/home/runner"]

# Required at runtime (fail-loud if missing): STEWRA_API_URL, STEWRA_RUNNER_CLONE_REPOS.
# Provide git/gh credentials + harness provider auth by mounting config or setting env — see CLOUD_VM.md.
#   pair once:  docker run ... stewra-runner pair <code>
#   then run:   docker run ... stewra-runner run   (the default CMD)
ENTRYPOINT ["node", "runner/dist/cli.js"]
CMD ["run"]

# ── hosted stage: the image STEWRA runs on its own infrastructure ─────────────────────────────────────
#
# Everything above is the runner a user puts on a VM they own. This stage is the one the provisioner
# starts per user, and it differs in three ways:
#
#   1. The coding agent is IN the image. A user's own VM is a machine they administer, so they install
#      Claude Code themselves; nobody administers this container, so it ships ready to run.
#   2. Repositories come from Stewra (`WORKSPACE_MODE=backend`), derived from the user's GitHub App
#      installation, rather than from a list the operator wrote out by hand.
#   3. `TMPDIR` points at the data volume. Session worktrees are created under `os.tmpdir()`, and the
#      container's default `/tmp` is neither persistent nor sized for a checkout of a real repository.
#
# Build from the REPO ROOT:
#   docker build -f runner/Dockerfile --target hosted -t stewra-runner-hosted:<version> .
FROM runtime AS hosted
USER root
# Pinned exactly, not floated: this image is what a user's coding session runs inside, and an agent that
# silently changed version underneath a running deployment is not something we could reproduce a bug in.
#
# Install scripts run deliberately: `@anthropic-ai/claude-code` fetches its native binary in a postinstall,
# and with `--ignore-scripts` the package installs "successfully" but every invocation fails with
# "claude native binary not installed" — a broken image that builds green. The verification below turns
# that from a runtime discovery into a build failure.
RUN npm install -g \
      @anthropic-ai/claude-code@2.1.220 \
      @agentclientprotocol/claude-agent-acp@0.64.2 \
 && claude --version \
 && claude-agent-acp --version \
 && mkdir -p /data/tmp \
 && chown -R runner:runner /data
USER runner

ENV STEWRA_RUNNER_WORKSPACE_MODE=backend \
    TMPDIR=/data/tmp
# The device token arrives as STEWRA_RUNNER_DEVICE_TOKEN at provision time — this image never pairs.
# Provider logins are written into ~/.stewra-runner/credentials/<harness> by the provisioner, not baked in.
