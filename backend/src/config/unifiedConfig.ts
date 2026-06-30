import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { GMAIL_LOOKBACK_MIN_DAYS, GMAIL_LOOKBACK_MAX_DAYS } from '@stewra/shared-types';

// Load backend/.env once, here. This is the ONE place process.env is read directly;
// everything else imports `config` from this module.
loadEnv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('2h'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  VAULT_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'VAULT_KEY must be 64 hex chars (32 bytes)'),
  SENTRY_DSN: z.string().optional(),
  // Where the website lives — used for the CORS origin and the post-OAuth redirect back to the app.
  WEB_APP_URL: z.string().url('WEB_APP_URL must be a valid URL'),
  // Google OAuth (read-only calendar). Required: Milestone 1 connects the calendar end-to-end.
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_REDIRECT_URI: z.string().url('GOOGLE_REDIRECT_URI must be a valid URL'),
  // Fallback Gmail lookback window (days) for a user who has never set their own. The durable
  // per-user choice lives in the user_preferences table; this is only the deploy-level default the
  // preferences service resolves to when no row exists. Bounded by the same shared contract limits
  // the preferences validator enforces.
  GMAIL_LOOKBACK_DAYS: z.coerce
    .number()
    .int()
    .min(GMAIL_LOOKBACK_MIN_DAYS)
    .max(GMAIL_LOOKBACK_MAX_DAYS),
  // The user picks the model provider. 'claude_cli' (default) shells out to the locally installed
  // `claude` CLI in print mode, using the user's existing Claude Code subscription — no API key.
  // The rest are API providers: 'anthropic' uses @anthropic-ai/sdk; 'openai', 'gemini', and 'grok'
  // all speak the OpenAI-compatible Chat Completions API (one adapter, different base URL + key).
  MODEL_PROVIDER: z
    .enum(['claude_cli', 'anthropic', 'openai', 'gemini', 'grok'])
    .default('claude_cli'),
  // Path/name of the Claude Code binary (overridable for non-standard installs).
  CLAUDE_CODE_PATH: z.string().min(1).default('claude'),
  // Model id for the chosen provider. Optional for claude_cli (uses the user's own configured
  // model); required for every API provider (checked below). Never hardcoded — the user supplies it.
  MODEL_ID: z.string().min(1).optional(),
  // Optional override for the OpenAI-compatible base URL (proxies, regions, gateways).
  MODEL_BASE_URL: z.string().url().optional(),
  // Per-provider API keys — only the selected provider's key is required (checked below). Names match
  // the existing product_advisor backend env so the same keys can be reused.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GROK_API_KEY: z.string().min(1).optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

// Default OpenAI-compatible endpoints per provider. These are protocol endpoints, not tunables;
// override any of them with MODEL_BASE_URL when pointing at a proxy/gateway.
const OPENAI_COMPATIBLE_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  grok: 'https://api.x.ai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
} as const;

const API_KEY_BY_PROVIDER: Record<string, string | undefined> = {
  anthropic: env.ANTHROPIC_API_KEY,
  openai: env.OPENAI_API_KEY,
  gemini: env.GEMINI_API_KEY,
  grok: env.GROK_API_KEY,
};

// Fail loud, up front, when the chosen API provider is missing its key or model id.
if (env.MODEL_PROVIDER !== 'claude_cli') {
  if (!API_KEY_BY_PROVIDER[env.MODEL_PROVIDER]) {
    throw new Error(
      `MODEL_PROVIDER='${env.MODEL_PROVIDER}' requires its API key (e.g. ${env.MODEL_PROVIDER.toUpperCase()}_API_KEY) to be set`,
    );
  }
  if (!env.MODEL_ID) {
    throw new Error(`MODEL_PROVIDER='${env.MODEL_PROVIDER}' requires MODEL_ID to be set`);
  }
}

const resolvedBaseUrl =
  env.MODEL_BASE_URL ??
  (env.MODEL_PROVIDER === 'openai' ||
  env.MODEL_PROVIDER === 'gemini' ||
  env.MODEL_PROVIDER === 'grok'
    ? OPENAI_COMPATIBLE_BASE_URLS[env.MODEL_PROVIDER]
    : '');

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  database: {
    url: env.DATABASE_URL,
  },
  auth: {
    jwtSecret: env.JWT_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    bcryptRounds: env.BCRYPT_ROUNDS,
  },
  vault: {
    keyHex: env.VAULT_KEY,
  },
  sentry: {
    dsn: env.SENTRY_DSN ?? '',
  },
  web: {
    appUrl: env.WEB_APP_URL,
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  },
  gmail: {
    // Default lookback window (days); a per-insight request may override within the shared bounds.
    lookbackDays: env.GMAIL_LOOKBACK_DAYS,
  },
  model: {
    provider: env.MODEL_PROVIDER,
    claudeCodePath: env.CLAUDE_CODE_PATH,
    // Empty string means "let the provider pick its own default" (only valid for claude_cli).
    modelId: env.MODEL_ID ?? '',
    // The selected provider's key ('' for claude_cli, which needs none).
    apiKey: API_KEY_BY_PROVIDER[env.MODEL_PROVIDER] ?? '',
    // OpenAI-compatible base URL ('' for claude_cli / anthropic, which don't use it).
    baseUrl: resolvedBaseUrl,
  },
} as const;

export type AppConfig = typeof config;
