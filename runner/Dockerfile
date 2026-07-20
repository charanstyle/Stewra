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
# Manifests first so `npm ci` caches until a dependency actually changes.
COPY package.json package-lock.json ./
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
 && chown -R runner:runner /data /home/runner
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
