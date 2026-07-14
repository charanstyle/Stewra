import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig';
import { connectionRepository } from '../repositories/connectionRepository';
import { gmailSyncService } from '../services/gmailSyncService';
import { briefingService } from '../services/briefingService';
import { whatsappRetentionService } from '../services/whatsappRetentionService';
import { logger } from '../utils/logger';

/**
 * The background heartbeat that makes Today feel alive: on an interval, for every user with an active
 * Google connection, sync new mail and rebuild their briefing + nudges so the page is already
 * populated when they arrive. Dependency-free (setInterval) and OFF unless config enables it, so
 * supertest/dev boxes never spin it. Per-user errors are captured and skipped — one failure never
 * sinks the batch.
 */

let timer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let running = false;
let sweeping = false;

/**
 * How often the WhatsApp retention sweep runs. Not an env knob on purpose: the WINDOW is configurable
 * (`WHATSAPP_PERSONAL_RETENTION_DAYS`) because it is a promise to the user, but the cadence is just how
 * finely we honour it. A window measured in days is honoured precisely enough by an hourly pass, and a
 * tunable here would only be a way to accidentally turn the promise off.
 */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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

/** Delete stored WhatsApp messages that have outlived the retention window. Guarded like `tick`. */
async function retentionSweep(): Promise<void> {
  if (sweeping) {
    logger.info('scheduler: previous WhatsApp retention sweep still running, skipping');
    return;
  }
  sweeping = true;
  try {
    await whatsappRetentionService.sweepAll();
  } catch (error) {
    Sentry.captureException(error);
  } finally {
    sweeping = false;
  }
}

/**
 * Start the background timers. Returns a stop function for graceful shutdown.
 *
 * The briefing tick and the WhatsApp retention sweep are started INDEPENDENTLY, and that separation is
 * deliberate. Retention is not a feature — it is the promise that we hold other people's messages for a
 * bounded time. Hanging it off `BRIEFING_SCHEDULE_ENABLED` would mean an operator who simply doesn't want
 * hourly Gmail polling silently stops deleting data, and would never be told. Each runs exactly when the
 * thing it is responsible for is switched on.
 */
export function startScheduler(): () => void {
  if (config.briefing.scheduleEnabled) {
    const intervalMs = config.briefing.intervalMinutes * 60 * 1000;
    logger.info('scheduler: briefing enabled', { intervalMinutes: config.briefing.intervalMinutes });
    // Fire-and-forget each tick; unref so the timer never keeps the process alive on its own.
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref();
  } else {
    logger.info('scheduler: briefing disabled (BRIEFING_SCHEDULE_ENABLED=false)');
  }

  if (config.whatsappPersonal.enabled) {
    logger.info('scheduler: WhatsApp retention sweep enabled', {
      retentionDays: config.whatsappPersonal.retentionDays,
    });
    retentionTimer = setInterval(() => {
      void retentionSweep();
    }, RETENTION_SWEEP_INTERVAL_MS);
    retentionTimer.unref();
  }

  return () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (retentionTimer !== null) {
      clearInterval(retentionTimer);
      retentionTimer = null;
    }
  };
}
