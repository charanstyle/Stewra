import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import {
  GMAIL_LOOKBACK_MIN_DAYS,
  GMAIL_LOOKBACK_MAX_DAYS,
  CALENDAR_LOOKAHEAD_MIN_DAYS,
  CALENDAR_LOOKAHEAD_MAX_DAYS,
} from '@stewra/shared-types';
import { meetsMinimumVersion } from '@stewra/shared-types';

/** The scopes Stewra now requests: read calendar + full Gmail read, plus modify (archive/label/
 * mark-read) and send — needed so Stewra can act on the user's behalf AFTER they confirm each action.
 * `gmail.readonly` is kept alongside `gmail.modify` for continuity with existing grants. Overridable
 * per deploy via GOOGLE_SCOPES, but never widened silently in code. */
const DEFAULT_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
].join(',');

/** The scopes that unlock the proactive assistant (reading full mail history + acting on confirm). A
 * connection whose GRANTED scopes are missing any of these needs a re-consent — the backend compares
 * a connection's stored granted scopes against this canonical set to set `needsReconsent`. */
const REQUIRED_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
].join(',');

/** Plain-language consent shown to the user — NOT a raw scope list (build-plan principle 6). The
 * default deploy copy; overridable via GOOGLE_CONSENT_PROMPT for localization/wording changes. */
const DEFAULT_GOOGLE_CONSENT_PROMPT =
  'Allow Stewra to read your Google Calendar and Gmail, and — only when you tap Confirm — send ' +
  'replies, archive, and label mail on your behalf? Stewra reads to summarise your inbox and spot ' +
  'what needs a reply; it never sends or changes anything until you explicitly approve it.';

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
  // How many days AHEAD the calendar is scanned for conflicts/free time. The counterpart to the
  // Gmail lookback default; bounded by the shared contract limits, overridable per deploy.
  GOOGLE_CALENDAR_LOOKAHEAD_DAYS: z.coerce
    .number()
    .int()
    .min(CALENDAR_LOOKAHEAD_MIN_DAYS)
    .max(CALENDAR_LOOKAHEAD_MAX_DAYS)
    .default(7),
  // Upper bounds on how many raw records are pulled before minimizing to facts. Caps API cost and
  // payload size; not user-facing. Sane defaults, overridable per deploy — never magic numbers.
  GOOGLE_MAX_EVENTS: z.coerce.number().int().min(1).max(500).default(50),
  GOOGLE_MAX_EMAILS: z.coerce.number().int().min(1).max(200).default(20),
  // The Sent-mail style observer's knobs (only runs after the user opts in). How many recent Sent
  // messages to sample per pass, how far back to look, and — for a style pattern to become a proposed
  // rule — the minimum number of sampled messages backing it and the minimum share of samples it must
  // hold. High thresholds keep proposals high-precision (§3). Sane defaults, overridable per deploy.
  SENT_MAIL_MAX_SAMPLES: z.coerce.number().int().min(1).max(200).default(40),
  SENT_MAIL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  SENT_MAIL_MIN_SUPPORT: z.coerce.number().int().min(1).max(200).default(5),
  SENT_MAIL_MIN_SHARE: z.coerce.number().min(0.5).max(1).default(0.6),
  // Comma-separated OAuth scopes. Defaults to read calendar + full Gmail read/modify/send;
  // overridable per deploy but deliberately explicit so widening access is a visible, auditable
  // config change — never in code.
  GOOGLE_SCOPES: z.string().min(1).default(DEFAULT_GOOGLE_SCOPES),
  // The canonical set a connection must have GRANTED to run the proactive assistant. A connection
  // missing any of these is flagged `needsReconsent`. Overridable but rarely changed.
  GOOGLE_REQUIRED_SCOPES: z.string().min(1).default(REQUIRED_GOOGLE_SCOPES),
  // Plain-language consent copy shown before redirecting to Google. Overridable for wording/locale.
  GOOGLE_CONSENT_PROMPT: z.string().min(1).default(DEFAULT_GOOGLE_CONSENT_PROMPT),
  // Email sync (full-body backfill + incremental) knobs. `RETENTION_DEFAULT_DAYS` is the deploy
  // fallback window when a user has no per-user `email_retention_days` set (the durable choice lives
  // in user_preferences). `BACKFILL_MAX_MESSAGES` caps a single backfill pass; `BACKFILL_PAGE_SIZE`
  // is the Gmail list page size (max 500); `SYNC_MAX_RETRIES` bounds exponential backoff on transient
  // Gmail errors. Sane defaults, overridable per deploy — never magic numbers in code.
  EMAIL_RETENTION_DEFAULT_DAYS: z.coerce.number().int().min(1).max(36500).default(90),
  EMAIL_BACKFILL_MAX_MESSAGES: z.coerce.number().int().min(1).max(100000).default(2000),
  EMAIL_BACKFILL_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  EMAIL_SYNC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(5),
  // Briefing/nudge shaping caps: how many "you owe a reply" threads become nudges in one run, and how
  // many recent messages feed the model's briefing context. Bound so the prompt and card list stay
  // sane. Sane defaults, overridable per deploy — never magic numbers in code.
  BRIEFING_MAX_NUDGES: z.coerce.number().int().min(1).max(50).default(8),
  BRIEFING_CONTEXT_MESSAGES: z.coerce.number().int().min(1).max(200).default(30),
  // The background briefing scheduler. OFF by default so supertest/dev boxes aren't spun up
  // unexpectedly; enable per deploy. `INTERVAL_MINUTES` is how often the tick syncs mail + rebuilds
  // each connected user's briefing. Sane defaults, overridable — never magic numbers in code.
  BRIEFING_SCHEDULE_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  BRIEFING_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(180),
  // Outbound mail (Mailu mailbox), used for the email-verification code. Required: a new account
  // can't be verified without it, so we fail loud rather than silently skip verification.
  SMTP_HOST: z.string().min(1, 'SMTP_HOST is required'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  // Implicit TLS (true, port 465) vs STARTTLS/plain (false). A string enum, NOT z.coerce.boolean —
  // coercion treats the literal 'false' as truthy, which would silently break TLS selection.
  SMTP_SECURE: z.enum(['true', 'false']).transform((v) => v === 'true'),
  SMTP_USER: z.string().min(1, 'SMTP_USER is required'),
  SMTP_PASSWORD: z.string().min(1, 'SMTP_PASSWORD is required'),
  // Envelope/header From (e.g. "Stewra <no-reply@stewra.com>").
  EMAIL_FROM: z.string().min(1, 'EMAIL_FROM is required'),
  // Verification policy knobs — sane defaults, overridable per deploy (no magic numbers in code).
  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  EMAIL_VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  // Password-reset policy knobs — same shape and defaults as verification, separately tunable.
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  PASSWORD_RESET_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  PASSWORD_RESET_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  // The learning loop's recall knobs: how many past-success exemplars to inject into a new task's
  // prompt, and the minimum full-text relevance (ts_rank) a memory must clear to be recalled. Sane
  // defaults, overridable per deploy — never magic numbers in code.
  MEMORY_RECALL_LIMIT: z.coerce.number().int().min(1).max(10).default(3),
  MEMORY_RECALL_MIN_RANK: z.coerce.number().min(0).max(1).default(0.01),
  // How many active process/style rules to inject into the model's system message when shaping a
  // task in a domain (the "how this user likes it done" profile). Bounded so the profile can't
  // balloon the prompt. Sane default, overridable per deploy — never a magic number in code.
  PROCESS_MEMORY_RECALL_LIMIT: z.coerce.number().int().min(1).max(50).default(12),
  // How far a rule's confidence moves per reinforcement event (a positive rating nudges the recalled
  // rules up by this, a negative one decays them by it), clamped to 0..100 in the repo. Reward accrues
  // by the raw signed RATING_REWARD scalar separately. Sane default, overridable — never magic in code.
  PROCESS_MEMORY_CONFIDENCE_STEP: z.coerce.number().int().min(1).max(50).default(5),
  // The WEAK negative reward applied to the style rules that shaped an insight when the user dismisses
  // it WITHOUT rating it (implicit engagement). Non-positive; deliberately small (half an explicit
  // "poor" = -1) so a single dismiss nudges but never tanks a rule — an explicit rating still
  // overrides. Set to 0 to disable the implicit signal and keep dismiss telemetry-only.
  PROCESS_MEMORY_IMPLICIT_DISMISS_REWARD: z.coerce.number().min(-3).max(0).default(-0.5),
  // The locally installed `claude` CLI (print mode) is ALWAYS preferred when it is actually runnable
  // on this host — it uses the operator's existing Claude Code subscription, no API key, no per-token
  // cost. Every other provider is a FALLBACK, used only when the CLI isn't available (e.g. inside the
  // prod container, which has no `claude` binary). `MODEL_PREFER_CLAUDE_CLI=false` turns the
  // auto-preference off so `MODEL_PROVIDER` is honoured verbatim (useful to exercise an API path on a
  // machine that also has the CLI). The runtime availability probe lives in the host (`modelClient`),
  // not here, so config stays a pure env parse.
  MODEL_PREFER_CLAUDE_CLI: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // The FALLBACK provider, used when the Claude CLI isn't available (or the preference is off).
  // 'claude_cli' also names the CLI explicitly. 'anthropic' uses @anthropic-ai/sdk; 'openai',
  // 'gemini', and 'grok' all speak the OpenAI-compatible Chat Completions API (one adapter, different
  // base URL + key). Defaults to 'claude_cli' so a dev box with the CLI needs no other config.
  MODEL_PROVIDER: z
    .enum(['claude_cli', 'openai', 'gemini', 'grok', 'anthropic'])
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
  // Redis is a REQUIRED dependency of the realtime layer: it backs the Socket.IO adapter (so multiple
  // backend instances share rooms/presence) and the presence store. Fail loud if absent — we never
  // silently fall back to a single-process in-memory bus (that would break fan-out in prod).
  REDIS_URL: z.string().url('REDIS_URL must be a valid redis:// URL'),
  // Channel/key prefix for the Socket.IO Redis adapter. Every backend instance that shares a prefix
  // forms one broadcast cluster (rooms fan out across them). Default 'socket.io' matches the adapter's
  // own default. Override it to run an isolated instance against a Redis that another deployment also
  // uses — a different prefix keeps the two clusters from cross-relaying each other's socket events.
  SOCKET_IO_ADAPTER_KEY: z.string().min(1).default('socket.io'),
  // Presence liveness window. A user is "online" while they hold ≥1 socket whose heartbeat is newer than
  // PRESENCE_STALE_MS; each backend instance re-stamps its live sockets every PRESENCE_REFRESH_MS. This
  // makes presence self-healing: a crashed/redeployed instance stops re-stamping, so its sockets age out
  // of the window and the user auto-goes-offline instead of being pinned "online" forever. Refresh must
  // be comfortably shorter than stale (checked post-parse) so a live socket never lapses between beats.
  PRESENCE_STALE_MS: z.coerce.number().int().positive().default(60_000),
  PRESENCE_REFRESH_MS: z.coerce.number().int().positive().default(20_000),
  // Master switch for audio/video calling. When false, the /calls routes return 503 and signaling is
  // not wired — a dev box without coturn isn't blocked. The TURN_* knobs below are required only when
  // this is true (checked post-parse, mirroring the MODEL_PROVIDER block).
  CALLS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // coturn (shared on `home`, distinct Stewra realm + secret). Comma-separated TURN URLs (e.g.
  // 'turns:turn.stewra.com:5349?transport=tcp'); the shared static-auth-secret used to mint ephemeral
  // HMAC-SHA1 creds; the realm; and the credential TTL. Required when CALLS_ENABLED=true. Force-relay
  // (no public STUN) so calls fail loud rather than silently degrade to a direct path.
  TURN_URLS: z.string().min(1).optional(),
  TURN_SECRET: z.string().min(1).optional(),
  TURN_REALM: z.string().min(1).optional(),
  TURN_CRED_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  // Background-ringing push credentials — all OPTIONAL. Ringing degrades to in-app when unset. APNs
  // VoIP/PushKit for iOS; an FCM service-account JSON (raw JSON string) for Android data pushes.
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),
  APNS_KEY_P8: z.string().min(1).optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  // Expo push access token — authorizes THIS backend to send through Expo's push service under Expo's
  // "Enhanced Security" (which rejects unauthenticated sends). Backs only the DEFERRED iOS approve-to-send
  // path (iOS → Expo → APNs); Android delivers the same prompt over raw FCM instead. OPTIONAL, and NOT
  // part of the WHATSAPP_EMAIL_APPROVAL_ENABLED required-when-on set until iOS ships. Distinct from the
  // call-ring FCM/APNs creds above.
  EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
  // Master switch for talk-to-Stewra voice (STT/TTS). When false, /messages/voice returns 503 so a dev
  // box without whisper.cpp/Piper isn't blocked. The WHISPER_*/PIPER_*/UPLOADS_* knobs are required
  // only when this is true (checked post-parse). Binaries are invoked via execFile (no shell) like the
  // Claude CLI — fail-loud, config-driven paths, never hardcoded.
  VOICE_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  WHISPER_BIN: z.string().min(1).optional(),
  WHISPER_MODEL: z.string().min(1).optional(),
  PIPER_BIN: z.string().min(1).optional(),
  PIPER_VOICE: z.string().min(1).optional(),
  // ffmpeg normalizes an uploaded clip (webm/opus, ogg, mp4, arbitrary-rate WAV) to the 16 kHz mono
  // 16-bit PCM WAV that whisper.cpp requires. Without it, real browser recordings (Opus) never decode.
  FFMPEG_BIN: z.string().min(1).optional(),
  // Where uploaded/synthesized media is written (a mounted volume in prod). Required when voice is on
  // (voice notes + TTS output land here); also used by any media upload. Served ONLY via the
  // authenticated GET /media/:id — never statically/publicly.
  UPLOADS_DIR: z.string().min(1).optional(),
  // Hard cap on an uploaded clip/attachment size, in bytes. Bounds multer + guards disk. Default 25 MB.
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(536870912).default(26214400),

  // ── WhatsApp channel (Meta's OFFICIAL Cloud API) ──────────────────────────────────────────────────
  // Master switch. When false, /channels/whatsapp + the webhook return 503 so a dev box without a Meta
  // app isn't blocked. The four secrets below are required only when true (checked post-parse).
  //
  // This is the SANCTIONED path: users message Stewra's business number from their own WhatsApp app, the
  // way they'd message an airline. Stewra never touches a user's WhatsApp account, so no user can be
  // banned. The separate, experimental companion-device channel (WHATSAPP_PERSONAL_*) is NOT configured
  // here and is NOT a server-side WhatsApp client: per build-plan principle 7 it runs in the user's own
  // Stewra Bridge app. No Baileys credential, socket, or dependency may ever land in this process.
  WHATSAPP_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // The Cloud API sender: Meta's numeric id for Stewra's business number (NOT the number itself).
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
  // Stewra's business number in E.164 WITHOUT '+', used to build the user's wa.me link-deeplink.
  WHATSAPP_BUSINESS_NUMBER: z.string().regex(/^\d{7,15}$/).optional(),
  // A Meta SYSTEM-USER token (never expires). A temp token dies in ~24h — never ship one.
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  // Echoed back during Meta's GET webhook handshake to prove we own the endpoint. Our own random string.
  WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),
  // The Meta app secret — keys the X-Hub-Signature-256 HMAC that authenticates every inbound webhook.
  // Without it the webhook would accept a forged POST from anyone who guessed the URL.
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  // Graph API version pinned per deploy — Meta deprecates versions on a schedule, so this must be a
  // visible, auditable bump, never a hardcoded string buried in the sender.
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
  // Graph API origin. Overridable so the channel can be driven end-to-end against a local stand-in
  // (and so a regional/proxied Graph endpoint is a config change, not a code change).
  WHATSAPP_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  // How long a link code stays valid. Short by design: it's a possession proof, not a password.
  WHATSAPP_LINK_CODE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),

  // ── Meta app for the COMMERCE plane (per-tenant WhatsApp via Embedded Signup) ─────────────────────
  // A DIFFERENT Meta app from the WHATSAPP_* one above, deliberately. That app owns Stewra's own
  // business number and one system-user token for the whole install; this one owns nothing and sends
  // nothing — it is the Tech Provider app through which each CLIENT connects their own WhatsApp
  // Business Account, and every credential it obtains is stored per-organization in the vault.
  //
  // They must not share an app id: the permissions differ (whatsapp_business_management,
  // whatsapp_business_messaging, business_management), the App Review is separate, and a single
  // revocation would otherwise take down both the assistant and every client at once.
  // Who operates THIS INSTALL — comma-separated account emails. Gates the platform-operator
  // surfaces (rate cards), which sit outside every org: they set the prices organizations are
  // billed at, and no org role may ever reach them. Empty (the default) means NOBODY passes the
  // gate — the fail-closed direction: an install that has not named its operators cannot load
  // prices, rather than an install that forgot the var letting anyone who guesses the route in.
  INSTALL_ADMIN_EMAILS: z.string().default(''),
  META_COMMERCE_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // The Meta app id, sent to the browser to launch the Embedded Signup dialog. Public by nature.
  META_COMMERCE_APP_ID: z.string().min(1).optional(),
  // The app secret. Keys the X-Hub-Signature-256 HMAC on /webhooks/meta and signs the server-side
  // code exchange. Without it the webhook cannot tell Meta from anyone who guessed the URL.
  META_COMMERCE_APP_SECRET:
    z.string().min(1).optional(),
  // The Embedded Signup configuration id — the flow Meta shows the client. Created in the app
  // dashboard, per-app, and NOT derivable from the app id.
  META_COMMERCE_CONFIG_ID: z.string().min(1).optional(),
  // Echoed back during Meta's GET webhook handshake to prove we own the endpoint. Our own random
  // string, and distinct from WHATSAPP_VERIFY_TOKEN so the two webhooks cannot be cross-verified.
  META_COMMERCE_VERIFY_TOKEN:
    z.string().min(1).optional(),
  // Graph version pinned per deploy, same reasoning as WHATSAPP_GRAPH_VERSION: a visible bump.
  META_COMMERCE_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
  // Graph origin. Overridable so the connect flow and the sender can be driven end-to-end against a
  // local stand-in in tests, same reasoning as WHATSAPP_GRAPH_BASE_URL.
  META_COMMERCE_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),

  // ── Commerce job worker (migration 043) ──────────────────────────────────────────────────────────
  // All three carry values rather than naming a target, so they are defaulted: they describe how
  // hard the worker polls, not what it acts on. Getting one wrong makes the queue slower or busier;
  // it cannot make it drain the wrong tenant's work.
  //
  // There is deliberately NO `COMMERCE_WORKER_ENABLED`. The worker starts with the rest of the
  // commerce plane, because a switch that turns off the only consumer while the enqueuers keep
  // running produces a silently growing backlog — the exact failure this queue replaced.
  COMMERCE_WORKER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),
  // How many jobs one pass claims. The batch runs sequentially, so this is also the longest a single
  // pass can take: batch × slowest handler.
  COMMERCE_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  // How long a claim is held before another worker may take the job. Must comfortably exceed the
  // slowest handler — too short and a job still running is claimed and run a second time, which is
  // why handlers are required to be idempotent rather than why this should be set tightly.
  COMMERCE_WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),

  // ── Commerce billing provider (migration 054's payment_attempts get written through this) ───────
  // How invoices are COLLECTED. `manual` is the default and needs nothing: the operator records
  // offline settlements by hand, and the system moves no money. Choosing `stripe` is what makes the
  // two secrets below required — enforced by the post-parse guard, so a Stripe deploy with a
  // missing credential fails at boot, not at the first charge.
  COMMERCE_BILLING_PROVIDER: z.enum(['manual', 'stripe']).default('manual'),
  // The secret API key ('sk_…'). Never the publishable key: this one creates charges.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  // Signs the Stripe-Signature header on /webhooks/payments ('whsec_…'). Without it an event
  // cannot be told apart from anyone who guessed the URL.
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  // API origin. Overridable so the charge path can be driven end-to-end against a local stand-in
  // in tests, same reasoning as META_COMMERCE_GRAPH_BASE_URL.
  STRIPE_API_BASE_URL: z.string().url().default('https://api.stripe.com'),

  // ── WhatsApp PERSONAL (experimental companion device, via the user-hosted Stewra Bridge) ──────────
  // A SECOND, separate, opt-in channel. Everything above is Meta's sanctioned Cloud API; everything here
  // is the unofficial path, where the user links their OWN WhatsApp account and CAN be permanently
  // banned for it. Off by default, and gated behind a typed acknowledgement of exactly that.
  //
  // Note what is NOT in this block: no WhatsApp credential, no session, no socket. Per build-plan
  // principle 7 the companion-device client runs on the USER'S OWN MACHINE. The backend's entire role is
  // to authenticate that bridge, queue confirmed sends for it, and store what it forwards.
  WHATSAPP_PERSONAL_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Where the user downloads the bridge app. Required when the feature is on — the web UI must never
  // carry a hardcoded URL, and there is no sensible default to guess.
  WHATSAPP_PERSONAL_DOWNLOAD_URL: z.string().url().optional(),
  // The oldest bridge build allowed to connect. This is a SAFETY control, not housekeeping: if a shipped
  // bridge turns out to reconnect too aggressively or ignore a rate limit, the accounts it burns are our
  // users' real accounts. Being able to refuse an old build is how we stop that spreading.
  WHATSAPP_PERSONAL_MIN_BRIDGE_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  // Hard ceiling on outbound sends, enforced in the bridge and re-checked here. Send volume is the single
  // biggest driver of WhatsApp bans, so this is a safety device rather than a nicety — keep it low.
  WHATSAPP_PERSONAL_MAX_SENDS_PER_MINUTE: z.coerce.number().int().min(1).max(60).default(10),
  // How long forwarded WhatsApp message bodies are kept before the retention sweep deletes them.
  // Mirrors the email store's window; the least data we can keep and still be useful.
  WHATSAPP_PERSONAL_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // ── WhatsApp EMAIL-APPROVAL (approve-to-send email over WhatsApp) ──────────────────────────────────
  // A THIRD, independent switch, in its OWN namespace on purpose so it can never be turned on as a side
  // effect of enabling either WhatsApp channel above (same reasoning as keeping `whatsapp_personal`
  // separate). When false the per-user opt-in cannot be enabled and both WhatsApp channels keep their
  // draft-and-defer refusal. Off by default. Phase 2 (actionable push) depends on
  // EXPO_ACCESS_TOKEN, enforced by the required-when-enabled guard below.
  WHATSAPP_EMAIL_APPROVAL_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // A bridge token is a long-lived DEVICE credential, so it is deliberately not a JWT and has no expiry
  // baked in — revocation is by database row, which is immediate. This bounds its raw entropy instead.
  WHATSAPP_PERSONAL_BRIDGE_TOKEN_BYTES: z.coerce.number().int().min(32).max(64).default(32),

  // ── Stewra RUNNER (coding-agent host on the user's OWN machine — a laptop or their cloud VM) ─────────
  // A separate, opt-in, off-by-default surface where the user runs coding agents (Claude Code, Codex,
  // Gemini CLI) on their own machine and drives them from Stewra. Its own namespace, like the WhatsApp
  // channels above, so enabling one capability can never enable this one as a side effect.
  RUNNER_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Where the user downloads the Stewra Runner. Required when the feature is on — no hardcoded client URL.
  RUNNER_DOWNLOAD_URL: z.string().url().optional(),
  // The oldest runner build allowed to connect — the lever to refuse a build with a known-bad execution
  // path. A SAFETY control: a runner executes code on the user's machine.
  RUNNER_MIN_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  // The NEWEST published runner build. Advertised to connecting runners (notify-only upgrade notice)
  // and to the web "Runners" panel. Distinct from MIN on purpose: MIN is the safety floor (oldest build
  // still allowed), LATEST is the upgrade target — advertising the floor as "latest" would tell every
  // out-of-date-but-allowed runner the wrong thing. Required when the feature is on; optional would
  // make the upgrade notice a silent no-op.
  RUNNER_LATEST_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  // A runner token is a long-lived DEVICE credential (not a JWT); revocation is by database row. This
  // bounds its raw entropy — 32 bytes of base64url is ample and unguessable.
  RUNNER_DEVICE_TOKEN_BYTES: z.coerce.number().int().min(16).max(64).default(32),
  // How long a single-use runner pairing code is valid before it expires.
  RUNNER_PAIR_CODE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),

  // ── Stewra GITHUB APP (click-through repo access for the hosted runner) ────────────────────────────
  // The three below describe the GitHub App this deploy registered. All-or-nothing: setting some but not
  // all is operator error and refuses to boot (enforced below). When none are set the feature simply
  // reports itself unconfigured — a laptop-only deploy needs no GitHub App.
  GITHUB_APP_ID: z.string().regex(/^\d+$/).optional(),
  // The App's URL slug (github.com/apps/<slug>) — where the user is sent to install it.
  GITHUB_APP_SLUG: z.string().min(1).optional(),
  // The App's private key, PEM, base64-encoded so it survives env-file transport as one line. This is
  // STEWRA'S OWN operational credential (like JWT_SECRET), not a user secret — hence env, not vault.
  GITHUB_APP_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  // GitHub API origin. A protocol endpoint, not a tunable — overridable so the service can be driven
  // against a local stand-in in tests, same reasoning as WHATSAPP_GRAPH_BASE_URL.
  GITHUB_API_BASE_URL: z.string().url().default('https://api.github.com'),

  // ── HOSTED RUNNERS (the cloud-first path: Stewra runs the coding-agent container itself) ────────────
  // Off by default and its own switch: a deploy that offers the laptop runner must not start creating
  // containers on its host because someone enabled a neighbouring feature.
  HOSTED_RUNNER_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Where the provisioner answers — the ONLY process holding the Docker socket, reachable only on the
  // internal compose network. A target: no default, ever.
  HOSTED_RUNNER_PROVISIONER_URL: z.string().url().optional(),
  // The provisioner's bearer token. This is the entire authentication story between the backend and a
  // process that can create containers on the host, so it is bounded here the same way as at the other
  // end (provisioner/src/config.ts requires ≥32 characters).
  HOSTED_RUNNER_PROVISIONER_TOKEN: z.string().min(32).optional(),
  // The exact runner image (repository:tag) to provision. Sent verbatim and rejected by the provisioner
  // unless it matches what THAT service was configured with — so a compromised backend cannot choose the
  // image its containers run.
  HOSTED_RUNNER_IMAGE: z.string().min(1).optional(),
  // The public origin a hosted runner dials back on (it reaches Stewra the same way any client does).
  // A target, and one that must be the PUBLIC origin rather than an internal name: guessing it would
  // produce runners that boot, fail to connect, and look like an image problem.
  HOSTED_RUNNER_API_URL: z.string().url().optional(),
  // How long a hosted runner may sit idle before its container is stopped to free the host. 0 disables
  // idle-stop. A behaviour knob, not a target — stopping is always recoverable (the next session wakes
  // it), and the volumes, which hold the actual work, are never touched by it.
  HOSTED_RUNNER_IDLE_STOP_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),
  // How long to wait for a woken container to connect its socket before failing the session honestly.
  HOSTED_RUNNER_WAKE_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(600).default(90),
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

// Fail loud, up front, when the fallback API provider is missing its key or model id. (The CLI needs
// neither; whether it's actually runnable is probed at host build time, not here.)
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

// Fail loud when calling is enabled but its coturn credentials are incomplete. Force-relay depends on
// real TURN creds; a half-configured realm would let calls silently fail at connect time.
if (env.CALLS_ENABLED) {
  const missing = (['TURN_URLS', 'TURN_SECRET', 'TURN_REALM'] as const).filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`CALLS_ENABLED=true requires: ${missing.join(', ')}`);
  }
}

// Fail loud when voice is enabled but a binary/model/uploads path is missing — STT/TTS can't run
// without them, and we never want a 500 mid-conversation from an unset path.
if (env.VOICE_ENABLED) {
  const missing = (
    ['WHISPER_BIN', 'WHISPER_MODEL', 'PIPER_BIN', 'PIPER_VOICE', 'FFMPEG_BIN', 'UPLOADS_DIR'] as const
  ).filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`VOICE_ENABLED=true requires: ${missing.join(', ')}`);
  }
}

// Fail loud when the WhatsApp channel is enabled but under-configured. A missing APP_SECRET would leave
// the webhook unable to authenticate Meta (i.e. open to a forged POST), and a missing ACCESS_TOKEN means
// replies silently never leave the building — both are worse than refusing to boot.
if (env.WHATSAPP_ENABLED) {
  const missing = (
    [
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_BUSINESS_NUMBER',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_APP_SECRET',
    ] as const
  ).filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`WHATSAPP_ENABLED=true requires: ${missing.join(', ')}`);
  }
}

// Fail loud when the commerce plane's Meta app is enabled but under-configured. Every one of these
// names a target or authenticates one: without the app secret /webhooks/meta cannot tell Meta from a
// forged POST carrying another tenant's WABA id; without the config id Embedded Signup opens the wrong
// flow (or none); without the verify token Meta's handshake fails and no client is ever reachable.
// Booting a half-configured multi-tenant messaging surface is strictly worse than not booting.
if (env.META_COMMERCE_ENABLED) {
  const missing = (
    [
      'META_COMMERCE_APP_ID',
      'META_COMMERCE_APP_SECRET',
      'META_COMMERCE_CONFIG_ID',
      'META_COMMERCE_VERIFY_TOKEN',
    ] as const
  ).filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`META_COMMERCE_ENABLED=true requires: ${missing.join(', ')}`);
  }
}

// Fail loud when a real payment provider is chosen but under-configured. Without the secret key no
// charge can be created; without the webhook secret /webhooks/payments cannot tell Stripe from a
// forged "it's paid" POST. A billing deploy that discovers this at the first charge has already
// issued invoices it cannot collect — strictly worse than not booting.
if (env.COMMERCE_BILLING_PROVIDER === 'stripe') {
  const missing = (['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const).filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`COMMERCE_BILLING_PROVIDER=stripe requires: ${missing.join(', ')}`);
  }
}

// Fail loud when the experimental companion-device channel is enabled but under-configured. Without a
// download URL the web UI would offer a consent gate leading nowhere; without a minimum bridge version
// we would have no way to refuse a build that is getting users banned. Both are worse than not booting.
if (env.WHATSAPP_PERSONAL_ENABLED) {
  const missing = (
    ['WHATSAPP_PERSONAL_DOWNLOAD_URL', 'WHATSAPP_PERSONAL_MIN_BRIDGE_VERSION'] as const
  ).filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`WHATSAPP_PERSONAL_ENABLED=true requires: ${missing.join(', ')}`);
  }
}

// Fail loud when the runner is enabled but under-configured. Without a download URL the "Runners" panel
// would offer a pairing flow leading nowhere; without a minimum version we could not refuse a build whose
// execution path we no longer trust. Both are worse than not booting.
if (env.RUNNER_ENABLED) {
  const missing = (['RUNNER_DOWNLOAD_URL', 'RUNNER_MIN_VERSION', 'RUNNER_LATEST_VERSION'] as const).filter(
    (k) => !env[k],
  );
  if (missing.length > 0) {
    throw new Error(`RUNNER_ENABLED=true requires: ${missing.join(', ')}`);
  }
  // LATEST below MIN is always operator error: it would tell every runner to "upgrade" to a build the
  // same config refuses at pairing. Refuse to boot rather than advertise a self-contradiction.
  const latest = env.RUNNER_LATEST_VERSION;
  const min = env.RUNNER_MIN_VERSION;
  if (latest !== undefined && min !== undefined && !meetsMinimumVersion(latest, min)) {
    throw new Error(
      `RUNNER_LATEST_VERSION (${latest}) must be >= RUNNER_MIN_VERSION (${min})`,
    );
  }
}

// Fail loud when the GitHub App is partially configured. Some-but-not-all is always operator error:
// a half-configured App would report itself "configured" to the UI and then fail at token mint time,
// deep inside a hosted runner's git operation — the worst possible place to discover a typo'd env file.
{
  const githubAppKeys = ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY_BASE64'] as const;
  const present = githubAppKeys.filter((k) => env[k]);
  if (present.length > 0 && present.length < githubAppKeys.length) {
    const missing = githubAppKeys.filter((k) => !env[k]);
    throw new Error(
      `GitHub App configuration is incomplete: ${present.join(', ')} set but ${missing.join(', ')} missing`,
    );
  }
}

// Fail loud when hosted runners are enabled but under-configured or unsupported by the rest of the
// config. Each of these is a target or a credential the feature cannot invent:
//   - without the provisioner URL/token there is nothing to create containers with;
//   - without the image there is nothing to run;
//   - without the public API URL every container Stewra creates boots and silently fails to connect;
//   - without RUNNER_ENABLED the `/runner` namespace is not even mounted, so a provisioned container
//     would have nowhere to dial — and a stopped feature that still bills for containers is worse;
//   - without a GitHub App there is no way to give the container a repository, which is the whole point.
// A half-configured hosted deploy fails at provision time, in front of a user, having already created a
// container it then has to roll back. Refusing to boot puts the failure in front of the operator instead.
if (env.HOSTED_RUNNER_ENABLED) {
  const missing = (
    [
      'HOSTED_RUNNER_PROVISIONER_URL',
      'HOSTED_RUNNER_PROVISIONER_TOKEN',
      'HOSTED_RUNNER_IMAGE',
      'HOSTED_RUNNER_API_URL',
    ] as const
  ).filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`HOSTED_RUNNER_ENABLED=true requires: ${missing.join(', ')}`);
  }
  if (!env.RUNNER_ENABLED) {
    throw new Error('HOSTED_RUNNER_ENABLED=true requires RUNNER_ENABLED=true');
  }
  if (env.GITHUB_APP_ID === undefined) {
    throw new Error(
      'HOSTED_RUNNER_ENABLED=true requires the GitHub App (GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY_BASE64)',
    );
  }
}

// The App's key arrives base64-wrapped; decode once, and refuse to boot on a value that is not a PEM —
// a corrupt key would otherwise surface as a signing error at the first token mint instead of here.
const githubAppPrivateKeyPem =
  env.GITHUB_APP_PRIVATE_KEY_BASE64 === undefined
    ? ''
    : Buffer.from(env.GITHUB_APP_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
if (env.GITHUB_APP_PRIVATE_KEY_BASE64 !== undefined && !githubAppPrivateKeyPem.includes('-----BEGIN')) {
  throw new Error('GITHUB_APP_PRIVATE_KEY_BASE64 does not decode to a PEM private key');
}

// Fail loud when approve-to-send email over WhatsApp is enabled but its push credential is missing.
// Android — the only shipped push surface — delivers the actionable Approve/Deny prompt via raw FCM v1
// DATA-ONLY (`fcmPushService`); a data-only message is what runs expo-notifications' receiver in the
// background and attaches the buttons (see emailApprovalPushService). So FCM_SERVICE_ACCOUNT_JSON is the
// load-bearing credential: without it the prompt silently never reaches the device, leaving the feature
// advertised but inert — worse than refusing to boot. EXPO_ACCESS_TOKEN is NOT required here because it
// backs only the deferred iOS path; add it to this set when iOS ships. (Phase 1's web approve card still
// works without push, but enabling the switch means the full approve-to-send experience, so we require
// the Android transport unconditionally when on.)
if (env.WHATSAPP_EMAIL_APPROVAL_ENABLED) {
  const missing = (['FCM_SERVICE_ACCOUNT_JSON'] as const).filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`WHATSAPP_EMAIL_APPROVAL_ENABLED=true requires: ${missing.join(', ')}`);
  }
}

// A socket must be re-stamped at least twice before its heartbeat could go stale, or a live but quiet
// socket would briefly flap offline between beats. Enforce a 2× safety margin loudly at boot.
if (env.PRESENCE_REFRESH_MS * 2 > env.PRESENCE_STALE_MS) {
  throw new Error(
    `PRESENCE_STALE_MS (${env.PRESENCE_STALE_MS}) must be at least 2× PRESENCE_REFRESH_MS (${env.PRESENCE_REFRESH_MS})`,
  );
}

const resolvedBaseUrl =
  env.MODEL_BASE_URL ??
  (env.MODEL_PROVIDER === 'openai' ||
  env.MODEL_PROVIDER === 'gemini' ||
  env.MODEL_PROVIDER === 'grok'
    ? OPENAI_COMPATIBLE_BASE_URLS[env.MODEL_PROVIDER]
    : '');

/**
 * The commerce plane's Meta app.
 *
 * A discriminated union rather than the `?? ''` shape the older sections use, on purpose: an empty
 * app secret would verify no HMAC and an empty config id would open no signup flow, and both would
 * do it QUIETLY, at the moment a client is trying to connect their business. Callers must narrow on
 * `enabled` first, and when they do the credentials are non-optional strings that are really there.
 */
export type MetaCommerceConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly appId: string;
      readonly appSecret: string;
      /** The Embedded Signup configuration id — which flow Meta shows the connecting client. */
      readonly configId: string;
      readonly verifyToken: string;
      readonly graphVersion: string;
      /** Graph origin, overridable so the connect flow can be driven against a local stand-in. */
      readonly graphBaseUrl: string;
    };

function readMetaCommerceConfig(): MetaCommerceConfig {
  if (!env.META_COMMERCE_ENABLED) return { enabled: false };
  // The post-parse guard above already refused to boot without these; this re-reads them as a type
  // narrowing that cannot be satisfied by a placeholder. If it ever throws, the guard has a hole.
  const { META_COMMERCE_APP_ID, META_COMMERCE_APP_SECRET, META_COMMERCE_CONFIG_ID } = env;
  const verifyToken = env.META_COMMERCE_VERIFY_TOKEN;
  if (
    META_COMMERCE_APP_ID === undefined ||
    META_COMMERCE_APP_SECRET === undefined ||
    META_COMMERCE_CONFIG_ID === undefined ||
    verifyToken === undefined
  ) {
    throw new Error('META_COMMERCE_ENABLED=true but its credentials are not all set');
  }
  return {
    enabled: true,
    appId: META_COMMERCE_APP_ID,
    appSecret: META_COMMERCE_APP_SECRET,
    configId: META_COMMERCE_CONFIG_ID,
    verifyToken,
    graphVersion: env.META_COMMERCE_GRAPH_VERSION,
    graphBaseUrl: env.META_COMMERCE_GRAPH_BASE_URL,
  };
}

/**
 * How invoices are collected — a discriminated union for the same reason MetaCommerceConfig is:
 * callers narrow on `provider` first, and in the `stripe` branch every credential is a real,
 * non-optional string. There is no way to hold a half-configured Stripe.
 */
export type CommerceBillingConfig =
  | { readonly provider: 'manual' }
  | {
      readonly provider: 'stripe';
      readonly secretKey: string;
      readonly webhookSecret: string;
      readonly apiBaseUrl: string;
    };

function readCommerceBillingConfig(): CommerceBillingConfig {
  if (env.COMMERCE_BILLING_PROVIDER !== 'stripe') return { provider: 'manual' };
  // The post-parse guard above already refused to boot without these; this re-reads them as a type
  // narrowing that cannot be satisfied by a placeholder. If it ever throws, the guard has a hole.
  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = env;
  if (STRIPE_SECRET_KEY === undefined || STRIPE_WEBHOOK_SECRET === undefined) {
    throw new Error('COMMERCE_BILLING_PROVIDER=stripe but its credentials are not all set');
  }
  return {
    provider: 'stripe',
    secretKey: STRIPE_SECRET_KEY,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    apiBaseUrl: env.STRIPE_API_BASE_URL,
  };
}

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
  // Lowercased once here so the middleware's comparison cannot be defeated by letter case. An
  // empty list is a valid state meaning "no one" — see the env comment.
  installAdmins: env.INSTALL_ADMIN_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0),
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
    // Split the comma-separated env into a trimmed, non-empty scope list once, here.
    scopes: env.GOOGLE_SCOPES.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    // The canonical scopes a connection must have granted to run the proactive assistant.
    requiredScopes: env.GOOGLE_REQUIRED_SCOPES.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    consentPrompt: env.GOOGLE_CONSENT_PROMPT,
    maxEvents: env.GOOGLE_MAX_EVENTS,
    maxEmails: env.GOOGLE_MAX_EMAILS,
  },
  emailSync: {
    // Deploy fallback retention window (days) when the user has set none; the durable per-user choice
    // lives in user_preferences. Also the cap + paging + retry bounds for backfill/incremental sync.
    retentionDefaultDays: env.EMAIL_RETENTION_DEFAULT_DAYS,
    backfillMaxMessages: env.EMAIL_BACKFILL_MAX_MESSAGES,
    backfillPageSize: env.EMAIL_BACKFILL_PAGE_SIZE,
    maxRetries: env.EMAIL_SYNC_MAX_RETRIES,
  },
  briefing: {
    // Max "owe a reply" threads turned into nudges per run, and how many recent messages feed the
    // model's briefing context.
    maxNudges: env.BRIEFING_MAX_NUDGES,
    contextMessages: env.BRIEFING_CONTEXT_MESSAGES,
    // Background scheduler: master switch + tick interval (minutes).
    scheduleEnabled: env.BRIEFING_SCHEDULE_ENABLED,
    intervalMinutes: env.BRIEFING_INTERVAL_MINUTES,
  },
  gmail: {
    // Default lookback window (days); a per-insight request may override within the shared bounds.
    lookbackDays: env.GMAIL_LOOKBACK_DAYS,
  },
  sentMailObserver: {
    // Sampling + evidence thresholds for the opt-in Sent-mail style observer. `maxSamples`/
    // `lookbackDays` bound the read; `minSupport`/`minShare` gate when a pattern is confident enough
    // to surface as a PROPOSED rule (never auto-applied).
    maxSamples: env.SENT_MAIL_MAX_SAMPLES,
    lookbackDays: env.SENT_MAIL_LOOKBACK_DAYS,
    minSupport: env.SENT_MAIL_MIN_SUPPORT,
    minShare: env.SENT_MAIL_MIN_SHARE,
  },
  calendar: {
    // How many days ahead to scan for conflicts and free time.
    lookaheadDays: env.GOOGLE_CALENDAR_LOOKAHEAD_DAYS,
  },
  email: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.EMAIL_FROM,
  },
  emailVerification: {
    ttlMinutes: env.EMAIL_VERIFICATION_TTL_MINUTES,
    maxAttempts: env.EMAIL_VERIFICATION_MAX_ATTEMPTS,
    resendCooldownSeconds: env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  },
  passwordReset: {
    ttlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    maxAttempts: env.PASSWORD_RESET_MAX_ATTEMPTS,
    resendCooldownSeconds: env.PASSWORD_RESET_RESEND_COOLDOWN_SECONDS,
  },
  memory: {
    // Max past-success exemplars injected into a new task's prompt, and the min ts_rank to recall.
    recallLimit: env.MEMORY_RECALL_LIMIT,
    recallMinRank: env.MEMORY_RECALL_MIN_RANK,
  },
  processMemory: {
    // Max active process/style rules injected into a task's system message (the style profile).
    recallLimit: env.PROCESS_MEMORY_RECALL_LIMIT,
    // How much a reinforcement (rated feedback) moves a recalled rule's confidence up/down.
    confidenceStep: env.PROCESS_MEMORY_CONFIDENCE_STEP,
    // Weak negative reward for a dismiss-without-rating (implicit engagement); 0 disables it.
    implicitDismissReward: env.PROCESS_MEMORY_IMPLICIT_DISMISS_REWARD,
  },
  model: {
    // The FALLBACK provider; the host prefers the Claude CLI over this whenever it's runnable.
    provider: env.MODEL_PROVIDER,
    // Whether to auto-prefer the local Claude CLI when available (off → honour `provider` verbatim).
    preferClaudeCli: env.MODEL_PREFER_CLAUDE_CLI,
    claudeCodePath: env.CLAUDE_CODE_PATH,
    // Empty string means "let the provider pick its own default" (only valid for claude_cli).
    modelId: env.MODEL_ID ?? '',
    // The selected provider's key ('' for claude_cli, which needs none).
    apiKey: API_KEY_BY_PROVIDER[env.MODEL_PROVIDER] ?? '',
    // OpenAI-compatible base URL ('' for claude_cli / anthropic, which don't use it).
    baseUrl: resolvedBaseUrl,
  },
  redis: {
    // Backs the Socket.IO adapter + presence store. Required — no single-process fallback.
    url: env.REDIS_URL,
    // Socket.IO adapter cluster prefix; override to isolate an instance sharing a Redis with another.
    adapterKey: env.SOCKET_IO_ADAPTER_KEY,
  },
  presence: {
    // A socket counts as live while its heartbeat is newer than staleMs; each instance re-stamps its
    // sockets every refreshMs. staleMs must exceed refreshMs (with margin) — enforced below.
    staleMs: env.PRESENCE_STALE_MS,
    refreshMs: env.PRESENCE_REFRESH_MS,
  },
  calls: {
    // Master switch; when false the /calls routes 503 and signaling stays unwired.
    enabled: env.CALLS_ENABLED,
    // Trimmed TURN URL list (force-relay). Empty when calling is disabled.
    turnUrls: (env.TURN_URLS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    // Shared static-auth-secret for the distinct Stewra realm; '' when disabled.
    turnSecret: env.TURN_SECRET ?? '',
    turnRealm: env.TURN_REALM ?? '',
    // TTL of a minted ephemeral credential (seconds).
    turnCredTtlSeconds: env.TURN_CRED_TTL_SECONDS,
  },
  push: {
    // APNs VoIP/PushKit (iOS) — all optional; ringing degrades to in-app when unset.
    apnsKeyId: env.APNS_KEY_ID ?? '',
    apnsTeamId: env.APNS_TEAM_ID ?? '',
    apnsBundleId: env.APNS_BUNDLE_ID ?? '',
    apnsKeyP8: env.APNS_KEY_P8 ?? '',
    // FCM service-account JSON (raw string) for Android data pushes; '' when unset.
    fcmServiceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON ?? '',
    // Expo push access token for the general actionable-notification channel (approve-to-send email).
    // '' when unset; the required-when-enabled guard above blocks boot if the feature is on without it.
    expoAccessToken: env.EXPO_ACCESS_TOKEN ?? '',
  },
  voice: {
    // Master switch; when false /messages/voice 503s. STT/TTS binaries invoked via execFile.
    enabled: env.VOICE_ENABLED,
    whisperBin: env.WHISPER_BIN ?? '',
    whisperModel: env.WHISPER_MODEL ?? '',
    piperBin: env.PIPER_BIN ?? '',
    piperVoice: env.PIPER_VOICE ?? '',
    ffmpegBin: env.FFMPEG_BIN ?? '',
  },
  whatsapp: {
    // Master switch; when false the channel routes + webhook 503. Official Meta Cloud API only —
    // users message Stewra's business number, so no user's WhatsApp account is ever at risk.
    enabled: env.WHATSAPP_ENABLED,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    /** Stewra's own number, E.164 without '+', for the user's wa.me deep link. */
    businessNumber: env.WHATSAPP_BUSINESS_NUMBER ?? '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN ?? '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? '',
    appSecret: env.WHATSAPP_APP_SECRET ?? '',
    graphVersion: env.WHATSAPP_GRAPH_VERSION,
    /** Graph origin. Overridable so the channel can be driven against a local stand-in, or a proxied
     *  / regional Graph endpoint, without a code change. */
    graphBaseUrl: env.WHATSAPP_GRAPH_BASE_URL,
    linkCodeTtlMs: env.WHATSAPP_LINK_CODE_TTL_MINUTES * 60 * 1000,
  },
  /**
   * The commerce plane's Meta app — a DIFFERENT app from `whatsapp` above. That one owns Stewra's own
   * business number; this one owns nothing and sends nothing, and exists so each client can connect
   * their own WhatsApp Business Account through Embedded Signup. Narrow on `.enabled` to reach the
   * credentials; there are no empty-string stand-ins here.
   */
  metaCommerce: readMetaCommerceConfig(),
  /** How invoices are collected. `manual` records money; only `stripe` moves it. */
  commerceBilling: readCommerceBillingConfig(),
  commerceWorker: {
    pollMs: env.COMMERCE_WORKER_POLL_MS,
    batchSize: env.COMMERCE_WORKER_BATCH_SIZE,
    leaseSeconds: env.COMMERCE_WORKER_LEASE_SECONDS,
  },
  whatsappPersonal: {
    // The EXPERIMENTAL companion-device channel. Separate namespace from `whatsapp` above on purpose:
    // these two are different products with different risk profiles, and collapsing them into one config
    // object is how someone eventually ships the dangerous one by flipping the safe one's switch.
    enabled: env.WHATSAPP_PERSONAL_ENABLED,
    /** Where the user gets the Stewra Bridge app. Empty unless the feature is enabled (fail-loud above). */
    downloadUrl: env.WHATSAPP_PERSONAL_DOWNLOAD_URL ?? '',
    /** Oldest bridge build allowed to connect — our lever to kill a build that is burning accounts. */
    minBridgeVersion: env.WHATSAPP_PERSONAL_MIN_BRIDGE_VERSION ?? '',
    maxSendsPerMinute: env.WHATSAPP_PERSONAL_MAX_SENDS_PER_MINUTE,
    retentionDays: env.WHATSAPP_PERSONAL_RETENTION_DAYS,
    bridgeTokenBytes: env.WHATSAPP_PERSONAL_BRIDGE_TOKEN_BYTES,
  },
  whatsappEmailApproval: {
    // The approve-to-send email-over-WhatsApp opt-in. Its own namespace, separate from both `whatsapp`
    // and `whatsappPersonal`, so enabling either of those can never enable this. When false the per-user
    // opt-in cannot be turned on and both WhatsApp channels keep refusing to send email.
    enabled: env.WHATSAPP_EMAIL_APPROVAL_ENABLED,
  },
  runner: {
    // The coding-agent runner surface. Its own namespace, separate from every WhatsApp switch above, so
    // enabling any of those can never enable this. When false the `/runner` socket namespace is not
    // mounted and every runner REST route reports the feature unavailable.
    enabled: env.RUNNER_ENABLED,
    /** Where the user gets the Stewra Runner. Empty unless the feature is enabled (fail-loud above). */
    downloadUrl: env.RUNNER_DOWNLOAD_URL ?? '',
    /** Oldest runner build allowed to connect — our lever to refuse a build we no longer trust to run. */
    minVersion: env.RUNNER_MIN_VERSION ?? '',
    /** Newest published build — what the notify-only upgrade notice points at. Empty when disabled. */
    latestVersion: env.RUNNER_LATEST_VERSION ?? '',
    deviceTokenBytes: env.RUNNER_DEVICE_TOKEN_BYTES,
    pairCodeTtlMs: env.RUNNER_PAIR_CODE_TTL_MINUTES * 60 * 1000,
  },
  githubApp: {
    /** True when this deploy registered a GitHub App (all three settings present — enforced above). */
    enabled: env.GITHUB_APP_ID !== undefined,
    appId: env.GITHUB_APP_ID ?? '',
    slug: env.GITHUB_APP_SLUG ?? '',
    /** The App's private key, decoded to PEM. Stewra's own operational credential, like the JWT secret. */
    privateKeyPem: githubAppPrivateKeyPem,
    /** GitHub API origin — overridable only so tests can stand in a local server. */
    apiBaseUrl: env.GITHUB_API_BASE_URL,
  },
  hostedRunner: {
    /**
     * The cloud-first path: Stewra provisions and runs the coding-agent container itself. Its own
     * switch, separate from `runner.enabled`, so a deploy can offer the laptop runner without ever
     * creating a container on its host. Enabling it REQUIRES `runner.enabled` and a GitHub App (both
     * enforced above), so this flag alone is enough for callers to gate on.
     */
    enabled: env.HOSTED_RUNNER_ENABLED,
    /** The provisioner's internal base URL. Empty unless enabled (fail-loud above). */
    provisionerUrl: env.HOSTED_RUNNER_PROVISIONER_URL ?? '',
    /** Bearer token for the provisioner — the whole authentication story to the Docker-socket holder. */
    provisionerToken: env.HOSTED_RUNNER_PROVISIONER_TOKEN ?? '',
    /** The exact repository:tag to provision. The provisioner rejects anything but its own configured image. */
    image: env.HOSTED_RUNNER_IMAGE ?? '',
    /** The PUBLIC origin a hosted runner dials back on, injected as STEWRA_API_URL. */
    apiUrl: env.HOSTED_RUNNER_API_URL ?? '',
    /** Idle window before a container is stopped. Zero disables the sweep entirely. */
    idleStopMinutes: env.HOSTED_RUNNER_IDLE_STOP_MINUTES,
    /** How long a session start waits for a woken container to connect before failing honestly. */
    wakeTimeoutMs: env.HOSTED_RUNNER_WAKE_TIMEOUT_SECONDS * 1000,
  },
  uploads: {
    // Mounted volume for uploaded/synthesized media; served only via authenticated GET /media/:id.
    dir: env.UPLOADS_DIR ?? '',
    maxBytes: env.MAX_UPLOAD_BYTES,
  },
} as const;

export type AppConfig = typeof config;
