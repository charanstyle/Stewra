/**
 * Fail-loud environment configuration, mirroring website/src/services/api.ts's
 * `VITE_API_BASE_URL` check. Expo inlines `EXPO_PUBLIC_*` vars at build time via
 * `process.env.EXPO_PUBLIC_*` (string literal access only — Babel's
 * inline-environment-variables transform cannot resolve a dynamic lookup).
 */
export interface AppConfig {
  readonly apiBaseUrl: string;
  readonly wsBaseUrl: string;
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`[config] Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig(): AppConfig {
  return {
    apiBaseUrl: requireEnv(
      process.env['EXPO_PUBLIC_API_BASE_URL'],
      'EXPO_PUBLIC_API_BASE_URL',
    ),
    wsBaseUrl: requireEnv(process.env['EXPO_PUBLIC_WS_BASE_URL'], 'EXPO_PUBLIC_WS_BASE_URL'),
  };
}

export const config: AppConfig = loadConfig();
