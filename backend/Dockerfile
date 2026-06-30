# Stewra backend — builds the whole workspace (shared-types → agent-runtime → backend) and runs the
# API. Build context is the REPO ROOT (see docker-compose.prod.yml), because the backend depends on
# the two workspace packages.
FROM node:20-alpine AS build
WORKDIR /app

# Install all workspace deps from manifests first, for better layer caching on source-only changes.
COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY backend/package.json backend/
COPY website/package.json website/
RUN npm ci

# Bring in the sources and build in dependency order.
COPY . .
RUN npm run build:types && npm run build:agent && npm run build -w backend

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The workspace at runtime: node_modules (with the @stewra/* symlinks into packages/), the built
# package dists those symlinks resolve to, and the compiled API. tsx is not used in prod — the
# entrypoint and migrations run from compiled JS.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=build /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build /app/packages/agent-runtime/package.json ./packages/agent-runtime/package.json
COPY --from=build /app/packages/agent-runtime/dist ./packages/agent-runtime/dist
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist

# Matches the backend's default PORT (config.port). The host maps a loopback port to this.
EXPOSE 3001
CMD ["node", "backend/dist/index.js"]
