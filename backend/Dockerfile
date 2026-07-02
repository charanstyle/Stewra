# Stewra backend — builds the whole workspace (shared-types → agent-runtime → backend) and runs the
# API. Build context is the REPO ROOT (see docker-compose.prod.yml), because the backend depends on
# the two workspace packages.
#
# Base is debian bookworm-slim (glibc), NOT alpine: the talk-to-Stewra voice layer bakes in the Piper
# TTS release binaries (glibc-linked) and a cmake-built whisper.cpp. Keeping build + runtime on the same
# libc means node's native modules (compiled during `npm ci`) also match the runtime.
FROM node:20-bookworm-slim AS build
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

# ── voice tools stage ─────────────────────────────────────────────────────────────────────────────
# Compiles whisper.cpp (STT) and fetches Piper (TTS) + one model each into /voice. All versions/URLs are
# build ARGs (overridable, pinned defaults) rather than magic constants. Skip entirely with
# --build-arg INSTALL_VOICE=false (then run with VOICE_ENABLED=false; /messages/voice returns 503).
FROM debian:bookworm-slim AS voice
ARG INSTALL_VOICE=true
ARG WHISPER_CPP_REF=v1.7.4
ARG WHISPER_MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
ARG PIPER_RELEASE_URL=https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
ARG PIPER_VOICE_URL=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx
ARG PIPER_VOICE_CONFIG_URL=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json
WORKDIR /build
RUN mkdir -p /voice/bin /voice/models /voice/piper /voice/piper-voices
RUN if [ "$INSTALL_VOICE" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake git wget ca-certificates && \
      # whisper.cpp — static libs so whisper-cli is self-contained apart from libc/libgomp/libstdc++.
      git clone --depth 1 --branch "$WHISPER_CPP_REF" https://github.com/ggerganov/whisper.cpp /build/whisper && \
      cmake -S /build/whisper -B /build/whisper/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF && \
      cmake --build /build/whisper/build --target whisper-cli -j "$(nproc)" && \
      cp /build/whisper/build/bin/whisper-cli /voice/bin/whisper-cli && \
      # whisper model.
      wget -qO /voice/models/ggml-base.en.bin "$WHISPER_MODEL_URL" && \
      # Piper release (bundles the piper binary, its shared libs, and espeak-ng-data).
      wget -qO /build/piper.tar.gz "$PIPER_RELEASE_URL" && \
      tar -xzf /build/piper.tar.gz -C /voice/piper --strip-components=1 && \
      # Piper voice (onnx weights + json config side by side).
      wget -qO /voice/piper-voices/en_US-amy-medium.onnx "$PIPER_VOICE_URL" && \
      wget -qO /voice/piper-voices/en_US-amy-medium.onnx.json "$PIPER_VOICE_CONFIG_URL" && \
      rm -rf /var/lib/apt/lists/* /build/whisper /build/piper.tar.gz ; \
    else \
      echo "INSTALL_VOICE=false — skipping voice toolchain (VOICE_ENABLED must be false at runtime)" ; \
    fi

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Piper's bundled shared libraries live beside its binary; add that dir so the dynamic loader finds them
# when the TTS service execs piper. libgomp1 is whisper.cpp's OpenMP runtime.
ENV LD_LIBRARY_PATH=/opt/voice/piper
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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

# Baked STT/TTS tools + models. Point stewra.env at these (see .env.example):
#   WHISPER_BIN=/opt/voice/bin/whisper-cli   WHISPER_MODEL=/opt/voice/models/ggml-base.en.bin
#   PIPER_BIN=/opt/voice/piper/piper         PIPER_VOICE=/opt/voice/piper-voices/en_US-amy-medium.onnx
COPY --from=voice /voice /opt/voice

# Matches the backend's default PORT (config.port). The host maps a loopback port to this.
EXPOSE 3001
CMD ["node", "backend/dist/index.js"]
