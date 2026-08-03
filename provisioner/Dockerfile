# Stewra provisioner — the ONLY container with the Docker socket. Build context is the REPO ROOT (see
# docker-compose.prod.yml), because this workspace depends on @stewra/shared-types.
#
# Deliberately thin: node, three runtime deps (undici, zod, shared-types), and ~600 lines of our own
# code. The whole point of splitting this out of the backend is that its attack surface is small
# enough to read end to end — every dependency added here is a dependency that can reach the socket.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first, for layer caching on source-only changes. Only the workspaces this image needs are
# copied; npm ci resolves the rest from the lockfile without their directories present.
COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY provisioner/package.json provisioner/
# The bridge workspace put electron in the root lockfile; its postinstall would pull a ~100MB binary
# this image has no use for.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci

COPY packages/shared-types packages/shared-types
COPY provisioner provisioner
COPY tsconfig.base.json ./
RUN npm run build:types && npm run build -w @stewra/provisioner

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# node_modules (with the @stewra/* symlinks into packages/), the shared-types dist those symlinks
# resolve to, and the compiled service. No tsx, no test files, no source.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=build /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build /app/provisioner/package.json ./provisioner/package.json
COPY --from=build /app/provisioner/dist ./provisioner/dist

# RUNS AS ROOT, deliberately, and this is not a gap worth closing: a process with the Docker socket
# can start a privileged container and own the host, so root-inside-this-container and node-inside-
# this-container are the same privilege. Dropping to `node` would need the HOST's docker gid baked in
# (it varies per machine) and would buy nothing. The real boundary is that this service is tiny, has
# no published ports, and is reachable only from the backend over an internal network.

# Matches config.port's default. Not published — the backend reaches it on the internal network.
EXPOSE 3050
CMD ["node", "provisioner/dist/index.js"]
