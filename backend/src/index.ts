// Sentry must be the FIRST import so it instruments everything loaded afterwards.
import './instrument';

import type { Server } from 'node:http';
import { createApp } from './app';
import { config } from './config/unifiedConfig';
import { assertDbConnection, closeDb } from './database/index';
import { logger } from './utils/logger';

/**
 * Process entry point. Owns the lifecycle that `app.ts` deliberately doesn't: it proves the DB is
 * reachable before accepting traffic, starts the listener, and shuts down gracefully so in-flight
 * requests finish and the PG pool is released.
 */
async function main(): Promise<void> {
  await assertDbConnection();
  logger.info('Database connection OK');

  const app = createApp();
  const server: Server = app.listen(config.port, () => {
    logger.info(`Stewra backend listening on port ${config.port}`);
  });

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully`);
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
