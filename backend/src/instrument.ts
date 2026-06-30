// Sentry/GlitchTip instrumentation. MUST be imported first (see index.ts) so it can
// instrument everything that loads afterward. No-op when SENTRY_DSN is unset (M0 default).
import * as Sentry from '@sentry/node';
import { config } from './config/unifiedConfig';

if (config.sentry.dsn) {
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.nodeEnv,
    tracesSampleRate: config.isProduction ? 0.1 : 1.0,
  });
}
