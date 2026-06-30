# Stewra website — builds the Vite SPA (with the API origin baked in at build time) and serves the
# static output via nginx. Build context is the REPO ROOT, because the SPA imports @stewra/shared-types.
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY backend/package.json backend/
COPY website/package.json website/
RUN npm ci

COPY . .
# Vite inlines import.meta.env at build time, so the API origin must be present NOW. There is no
# hardcoded fallback (website/src/services/api.ts throws if it is missing) — fail the build loud.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN test -n "$VITE_API_BASE_URL" || (echo "ERROR: VITE_API_BASE_URL build arg is required" >&2 && exit 1)
RUN npm run build:types && npm run build -w website

FROM nginx:alpine AS runtime
COPY website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/website/dist /usr/share/nginx/html
EXPOSE 80
