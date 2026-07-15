import { z } from 'zod';

/**
 * Where this bridge talks to Stewra, and what it calls itself.
 *
 * The API URL is NOT baked in. A bridge is a binary on someone else's machine — the last place you want a
 * hardcoded hostname, because you cannot fix it there. It comes from the environment at launch (and, when
 * packaged, from the build), and if it is missing the app refuses to start rather than guessing at a
 * default and quietly pointing a user's WhatsApp session at the wrong server.
 */
const schema = z.object({
  /** e.g. `https://www.stewra.com` — the same origin the web app is served from. */
  apiBaseUrl: z.string().url(),
  /** `x.y.z`. The server refuses a bridge older than its configured minimum, so this must be truthful. */
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});

export type BridgeConfig = z.infer<typeof schema>;

export interface BridgeEnv {
  readonly STEWRA_API_URL?: string | undefined;
}

/** Build the config or throw. Loud, at boot, where a human is watching — never a silent fallback. */
export function loadBridgeConfig(env: BridgeEnv, appVersion: string): BridgeConfig {
  const parsed = schema.safeParse({ apiBaseUrl: env.STEWRA_API_URL, appVersion });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Stewra Bridge is misconfigured and cannot start (${detail}). Set STEWRA_API_URL.`);
  }
  return parsed.data;
}
