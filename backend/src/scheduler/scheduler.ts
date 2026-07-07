import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig';
import { connectionRepository } from '../repositories/connectionRepository';
import { gmailSyncService } from '../services/gmailSyncService';
import { briefingService } from '../services/briefingService';
import { logger } from '../utils/logger';

/**
 * The background heartbeat that makes Today feel alive: on an interval, for every user with an active
 * Google connection, sync new mail and rebuild their briefing + nudges so the page is already
 * populated when they arrive. Dependency-free (setInterval) and OFF unless config enables it, so
 * supertest/dev boxes never spin it. Per-user errors are captured and skipped — one failure never
 * sinks the batch.
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Run one pass over all connected users. Guarded so overlapping ticks can't stack. */
async function tick(): Promise<void> {
  if (running) {
    logger.info('scheduler: previous tick still running, skipping');
    return;
  }
  running = true;
  try {
    const userIds = await connectionRepository.activeUserIds('google');
    logger.info('scheduler: briefing tick starting', { users: userIds.length });
    for (const userId of userIds) {
      try {
        await gmailSyncService.syncForUser(userId);
        await briefingService.computeAndStore(userId);
      } catch (error) {
        Sentry.captureException(error);
        logger.error('scheduler: per-user briefing failed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info('scheduler: briefing tick complete');
  } catch (error) {
    Sentry.captureException(error);
  } finally {
    running = false;
  }
}

/** Start the scheduler if enabled. Returns a stop function for graceful shutdown. */
export function startScheduler(): () => void {
  if (!config.briefing.scheduleEnabled) {
    logger.info('scheduler: disabled (BRIEFING_SCHEDULE_ENABLED=false)');
    return () => {};
  }
  const intervalMs = config.briefing.intervalMinutes * 60 * 1000;
  logger.info('scheduler: enabled', { intervalMinutes: config.briefing.intervalMinutes });
  // Fire-and-forget each tick; unref so the timer never keeps the process alive on its own.
  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  return () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}
