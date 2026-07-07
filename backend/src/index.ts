// Sentry must be the FIRST import so it instruments everything loaded afterwards.
import './instrument';

import { createServer, type Server } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createApp } from './app';
import { config } from './config/unifiedConfig';
import { assertDbConnection, closeDb } from './database/index';
import { logger } from './utils/logger';
import { initSockets } from './websocket';
import { startScheduler } from './scheduler/scheduler';
import type { AppServer } from './websocket/types';

/**
 * Process entry point. Owns the lifecycle that `app.ts` deliberately doesn't: it proves the DB is
 * reachable before accepting traffic, starts the listener, and shuts down gracefully so in-flight
 * requests finish and the PG pool is released.
 */
async function main(): Promise<void> {
  await assertDbConnection();
  logger.info('Database connection OK');

  const app = createApp();
  // Own the http.Server explicitly (rather than app.listen) so Socket.IO can attach to it. createApp()
  // stays listener-free for supertest; the realtime layer lives only here on the running process.
  const server: Server = createServer(app);
  const io: AppServer = new SocketIOServer(server, {
    // The website is the browser client; RN sends the same token via handshake auth.
    cors: { origin: config.web.appUrl, credentials: true },
  });
  initSockets(io);

  server.listen(config.port, () => {
    logger.info(`Stewra backend listening on port ${config.port}`);
  });

  // Start the proactive briefing scheduler after the listener is up (no-op unless enabled in config).
  const stopScheduler = startScheduler();

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    stopScheduler();
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
            process.exit(1);
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
  process.exit(1);
});
