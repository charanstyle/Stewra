/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Stewra backend, e.g. http://localhost:3001. Required — no hardcoded fallback. */
  readonly VITE_API_BASE_URL: string;
  /** WebSocket origin for Socket.IO, e.g. http://localhost:3001. Optional — defaults to the API origin. */
  readonly VITE_WS_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
