/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Stewra backend, e.g. http://localhost:3001. Required — no hardcoded fallback. */
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
