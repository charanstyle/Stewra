// Sentry must be the FIRST import so it instruments everything loaded afterwards.
import './instrument.js';

import * as Sentry from '@sentry/node';
import { createServer, type Server } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createApp } from './app.js';
import { config } from './config/unifiedConfig.js';
import { assertDbConnection, closeDb } from './database/index.js';
import { logger } from './utils/logger.js';
import { initSockets } from './websocket/index.js';
import { startScheduler } from './scheduler/scheduler.js';
// The commerce plane's own background work, started here rather than folded into `startScheduler`:
// that scheduler belongs to the personal-assistant plane, and this file is the composition root
// where the two contexts are allowed to meet.
import { startCommerceScheduler } from './commerce/scheduler/commerceScheduler.js';
import { storeSubscriptionService } from './commerce/services/storeSubscriptionService.js';
import type { AppServer } from './websocket/types.js';

/**
 * Process entry point. Owns the lifecycle that `app.ts` deliberately doesn't: it proves the DB is
 * reachable before accepting traffic, starts the listener, and shuts down gracefully so in-flight
 * requests finish and the PG pool is released.
 */
async function main(): Promise<void> {
  await assertDbConnection();
  logger.info('Database connection OK');

  // A store-enabled install must be able to say WHICH plan a verified purchase buys before it is
  // allowed to sell one. Config can only prove a name was typed; this proves it resolves. No-op
  // unless APPLE_STORE_ENABLED or GOOGLE_PLAY_ENABLED, and a refusal here is the point — the
  // alternative is discovering the mismatch from a customer who has already been charged.
  await storeSubscriptionService.assertStorePlanLoaded();

  const app = createApp();
  // Own the http.Server explicitly (rather than app.listen) so Socket.IO can attach to it. createApp()
  // stays listener-free for supertest; the realtime layer lives only here on the running process.
  const server: Server = createServer(app);
  const io: AppServer = new SocketIOServer(server, {
    // The website is the browser client; RN sends the same token via handshake auth.
    cors: { origin: config.web.appUrl, credentials: true },
    // A WhatsApp voice note crosses the /bridge namespace as base64 (the bridge caps the file at 3 MiB,
    // so ≤ 4 MiB of text plus envelope). Socket.IO's 1 MiB default would silently DROP the connection on
    // such a frame; this sits above the largest honest frame and below anything worth calling abuse.
    maxHttpBufferSize: 6 * 1024 * 1024,
  });
  initSockets(io);

  server.listen(config.port, () => {
    logger.info(`Stewra backend listening on port ${config.port}`);
  });

  // Start the proactive briefing scheduler after the listener is up (no-op unless enabled in config).
  const stopScheduler = startScheduler();
  // No-op unless META_COMMERCE_ENABLED. Keeps connected clients' WhatsApp credentials alive and
  // marks the ones that could not be kept, so a channel never stops working without saying why.
  const stopCommerceScheduler = startCommerceScheduler();

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    stopScheduler();
    stopCommerceScheduler();
    // Close Socket.IO first (drops live connections) before the HTTP server stops accepting.
    io.close(() => {
      server.close(() => {
        closeDb()
          .then(() => {
            logger.info('Shutdown complete');
            process.exit(0);
          })
          .catch((err: unknown) => {
            logger.error('Error during shutdown', {
              error: err instanceof Error ? err.message : String(err),
            });
            // Flush before exiting: Sentry's transport is async, so `process.exit` would otherwise
            // discard the event that was just queued. A dirty shutdown is how connection leaks and
            // half-written state start, and it is invisible if the report never leaves the process.
            Sentry.captureException(err, { tags: { surface: 'shutdown' } });
            void Sentry.flush(2000).then(() => process.exit(1));
          });
      });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.error('Fatal error during startup', {
    error: err instanceof Error ? err.message : String(err),
  });
  // The single most important event this process can send: it refused to start, so there is no
  // /health to scrape and no request log to read. Flushed for the same reason as the shutdown path.
  Sentry.captureException(err, { tags: { surface: 'startup' } });
  void Sentry.flush(2000).then(() => process.exit(1));
});
