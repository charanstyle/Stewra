import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig.js';
import { connectionRepository } from '../repositories/connectionRepository.js';
import { gmailSyncService } from '../services/gmailSyncService.js';
import { transactionSyncService } from '../services/transactionSyncService.js';
import { briefingService } from '../services/briefingService.js';
import { preferencesService } from '../services/preferencesService.js';
import { whatsappRetentionService } from '../services/whatsappRetentionService.js';
import { hostedRunnerService } from '../services/hostedRunnerService.js';
import { logger } from '../utils/logger.js';

/**
 * The background heartbeat that makes Today feel alive: on an interval, for every user with an active
 * Google connection, sync new mail and rebuild their briefing + nudges so the page is already
 * populated when they arrive. Dependency-free (setInterval) and OFF unless config enables it, so
 * supertest/dev boxes never spin it. Per-user errors are captured and skipped — one failure never
 * sinks the batch.
 */

let timer: NodeJS.Timeout | null = null;
let moneyTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let idleStopTimer: NodeJS.Timeout | null = null;
let running = false;
let moneySyncing = false;
let sweeping = false;
let reconciling = false;
let idleStopping = false;

/**
 * How often the WhatsApp retention sweep runs. Not an env knob on purpose: the WINDOW is configurable
 * (`WHATSAPP_PERSONAL_RETENTION_DAYS`) because it is a promise to the user, but the cadence is just how
 * finely we honour it. A window measured in days is honoured precisely enough by an hourly pass, and a
 * tunable here would only be a way to accidentally turn the promise off.
 */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How often hosted runners are reconciled against what Docker actually has. Hourly, and not an env knob:
 * this sweep exists to catch drift that only happens on failure paths (a rollback that could not reach
 * the provisioner, a host reboot), and the right cadence for that is "often enough that nobody pays for
 * an orphan overnight" — which an hour is, and which a tunable would only be a way to disable.
 */
const HOSTED_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How often idle hosted containers are checked. Five minutes: the WINDOW is configurable
 * (`HOSTED_RUNNER_IDLE_STOP_MINUTES`, because it is a promise about the user's runner staying warm),
 * while this is only how finely that window is honoured.
 */
const HOSTED_IDLE_STOP_INTERVAL_MS = 5 * 60 * 1000;

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
        // The global kill switch: a paused user gets NO background work — no Gmail fetch, no
        // briefing — not merely an empty result. Checked per user so one user's pause never
        // affects the rest of the batch.
        if (await preferencesService.pauseAll(userId)) {
          continue;
        }
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

/** Run one transactions-sync pass over every user with an active bank connection. Guarded like
 * `tick`, and on its OWN timer + flag: bank syncing must not silently stop because an operator
 * turned off Gmail polling (the same separation argument as the retention sweep). */
async function moneyTick(): Promise<void> {
  if (moneySyncing) {
    logger.info('scheduler: previous money tick still running, skipping');
    return;
  }
  moneySyncing = true;
  try {
    const userIds = await connectionRepository.activeUserIds('aggregator');
    logger.info('scheduler: money tick starting', { users: userIds.length });
    for (const userId of userIds) {
      try {
        // Same kill-switch rule as the briefing tick: paused means no bank fetch at all.
        if (await preferencesService.pauseAll(userId)) {
          continue;
        }
        await transactionSyncService.syncForUser(userId);
      } catch (error) {
        Sentry.captureException(error);
        logger.error('scheduler: per-user money sync failed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info('scheduler: money tick complete');
  } catch (error) {
    Sentry.captureException(error);
  } finally {
    moneySyncing = false;
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
 * Reconcile hosted runner containers with the device rows that own them. Guarded like `tick`.
 *
 * Failures are captured and swallowed rather than rethrown: the sweep runs unattended, and one hour where
 * the provisioner was restarting must not stop the next hour from running.
 */
async function hostedReconcile(): Promise<void> {
  if (reconciling) {
    logger.info('scheduler: previous hosted-runner reconcile still running, skipping');
    return;
  }
  reconciling = true;
  try {
    await hostedRunnerService.reconcile();
  } catch (error) {
    Sentry.captureException(error);
    logger.error('scheduler: hosted-runner reconcile failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    reconciling = false;
  }
}

/** Stop hosted containers idle past their window. Guarded like `tick`; never touches their volumes. */
async function hostedIdleStop(): Promise<void> {
  if (idleStopping) {
    logger.info('scheduler: previous hosted-runner idle-stop still running, skipping');
    return;
  }
  idleStopping = true;
  try {
    await hostedRunnerService.idleStop();
  } catch (error) {
    Sentry.captureException(error);
    logger.error('scheduler: hosted-runner idle-stop failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    idleStopping = false;
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

  if (config.moneySync.scheduleEnabled) {
    const moneyIntervalMs = config.moneySync.intervalMinutes * 60 * 1000;
    logger.info('scheduler: transactions sync enabled', {
      intervalMinutes: config.moneySync.intervalMinutes,
    });
    moneyTimer = setInterval(() => {
      void moneyTick();
    }, moneyIntervalMs);
    moneyTimer.unref();
  } else {
    logger.info('scheduler: transactions sync disabled (TRANSACTIONS_SYNC_ENABLED=false)');
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

  // Hosted runners are containers Stewra runs and pays for. Reconciliation is what keeps that bounded:
  // without it, every failed rollback leaves a container alive that no user can see and nothing will
  // ever stop. Tied to `hostedRunner.enabled` and nothing else, for the same reason the retention sweep
  // is tied to its own flag — a sweep that protects against a cost or a promise must not be switchable
  // off as a side effect of an unrelated setting.
  if (config.hostedRunner.enabled) {
    logger.info('scheduler: hosted-runner reconcile enabled');
    reconcileTimer = setInterval(() => {
      void hostedReconcile();
    }, HOSTED_RECONCILE_INTERVAL_MS);
    reconcileTimer.unref();

    if (config.hostedRunner.idleStopMinutes > 0) {
      logger.info('scheduler: hosted-runner idle-stop enabled', {
        idleStopMinutes: config.hostedRunner.idleStopMinutes,
      });
      idleStopTimer = setInterval(() => {
        void hostedIdleStop();
      }, HOSTED_IDLE_STOP_INTERVAL_MS);
      idleStopTimer.unref();
    } else {
      logger.info('scheduler: hosted-runner idle-stop disabled (HOSTED_RUNNER_IDLE_STOP_MINUTES=0)');
    }
  }

  return () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (moneyTimer !== null) {
      clearInterval(moneyTimer);
      moneyTimer = null;
    }
    if (retentionTimer !== null) {
      clearInterval(retentionTimer);
      retentionTimer = null;
    }
    if (reconcileTimer !== null) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
    if (idleStopTimer !== null) {
      clearInterval(idleStopTimer);
      idleStopTimer = null;
    }
  };
}
