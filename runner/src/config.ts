import { z } from 'zod';

/**
 * Where this runner talks to Stewra, and what it calls itself.
 *
 * The API URL is NOT baked in — for the same reason it isn't in the bridge (`bridge/src/core/config.ts`):
 * a runner is a binary on someone else's machine, the last place you want a hardcoded hostname, because
 * you cannot fix it there. It comes from the environment at launch, and if it is missing the runner
 * refuses to start rather than guessing a default and quietly pointing at the wrong server.
 */
const schema = z.object({
  /** e.g. `https://www.stewra.com` — the same origin the web app is served from. */
  apiBaseUrl: z.string().url(),
  /**
   * The path prefix the backend is mounted under, both for REST and Socket.IO. In production the backend
   * sits behind a reverse proxy at `/api` (so REST is `/api/runner/...` and the socket path is
   * `/api/socket.io`); a backend run directly (a dev box, a self-hoster who didn't add the proxy) serves at
   * the root, so this must be settable to `''`. Hardcoding `/api` — the bridge's mistake — makes the runner
   * unusable against anything but the canonical proxy. Trailing slashes are trimmed.
   */
  apiPrefix: z.string(),
  /** `x.y.z`. The server may refuse a runner older than its configured minimum, so this must be truthful. */
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});

export type RunnerConfig = z.infer<typeof schema>;

export interface RunnerEnv {
  readonly STEWRA_API_URL?: string | undefined;
  readonly STEWRA_API_PREFIX?: string | undefined;
}

/** Build the config or throw. Loud, at boot, where a human is watching — never a silent fallback. */
export function loadRunnerConfig(env: RunnerEnv, appVersion: string): RunnerConfig {
  // Default to the production proxy prefix; trim any trailing slash so `${prefix}/socket.io` is clean.
  const rawPrefix = env.STEWRA_API_PREFIX ?? '/api';
  const apiPrefix = rawPrefix.replace(/\/+$/, '');
  const parsed = schema.safeParse({ apiBaseUrl: env.STEWRA_API_URL, apiPrefix, appVersion });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Stewra Runner is misconfigured and cannot start (${detail}). Set STEWRA_API_URL.`);
  }
  return parsed.data;
}
