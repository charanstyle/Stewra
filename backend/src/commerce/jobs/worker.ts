import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import type { CommerceJob } from '@stewra/shared-types';
import { jobRepository } from '../repositories/jobRepository.js';
import { handlerFor } from './registry.js';
import type { JobOutcome } from './types.js';
import { config } from '../../config/unifiedConfig.js';
import { logger } from '../../utils/logger.js';

/**
 * The first retry delay. Four seconds, then quadrupling: 4s · 16s · 64s · 256s · 1024s.
 *
 * Quadrupling rather than doubling because the faults this backs off from are mostly other people's
 * rate limits and outages, and those are measured in minutes. Doubling from four seconds spends five
 * attempts inside the first minute and gives up before a Graph API incident has finished.
 */
const BACKOFF_BASE_MS = 4_000;

/** No retry waits longer than this. An hour is well inside every deadline the queue currently serves. */
const BACKOFF_CAP_MS = 60 * 60 * 1000;

/**
 * How long a retry waits, given how many attempts have already been made.
 *
 * Jittered by up to 20%. Without it, a Meta outage that fails fifty jobs at once has them all come
 * back at the same instant, five times over — the retry itself becomes the second outage.
 */
function backoffMs(attempts: number): number {
  const exponential = BACKOFF_BASE_MS * Math.pow(4, Math.max(0, attempts - 1));
  const capped = Math.min(exponential, BACKOFF_CAP_MS);
  return Math.round(capped * (1 + Math.random() * 0.2));
}

/**
 * THE COMMERCE PLANE'S JOB WORKER.
 *
 * Claims leased batches from `commerce_jobs`, runs each through its handler, and records what
 * happened. Replaces what `setInterval` could not do: try again, wait longer each time, stop after a
 * bounded number of tries, and leave a row saying so.
 *
 * The loop never throws. A pass that failed is logged and the next one runs — a background worker
 * that dies on its first bad hour is worse than one that never existed, because the enqueuers keep
 * enqueueing into a queue nothing is draining.
 */
class CommerceWorker {
  /**
   * Who holds a lease. Hostname and pid so an operator reading `locked_by` can find the process, plus
   * a random suffix because two workers in the same container would otherwise be indistinguishable —
   * and "which of these two is stuck" is exactly the question that string exists to answer.
   */
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private stopping = false;

  /**
   * Run one pass: claim a batch, run it, record outcomes. Returns how many jobs were processed.
   *
   * Public and awaitable on purpose. The timer calls it, and so do the tests — a queue whose
   * behaviour can only be observed by waiting for a real interval is a queue with untestable retry
   * semantics, which is most of what it exists to provide.
   */
  async runOnce(): Promise<number> {
    const jobs = await jobRepository.claim(
      this.workerId,
      config.commerceWorker.leaseSeconds,
      config.commerceWorker.batchSize,
    );
    for (const job of jobs) {
      await this.run(job);
    }
    return jobs.length;
  }

  /** Run one claimed job and record the outcome. Never throws. */
  private async run(job: CommerceJob): Promise<void> {
    const handler = handlerFor(job.kind);
    if (handler === null) {
      // A kind this build does not know. Retrying cannot teach it one, so this is terminal — and it
      // is `failed` rather than `dead`, because nothing was actually attempted.
      await jobRepository.markTerminal(job.id, 'failed', `no handler registered for kind '${job.kind}'`);
      logger.error('commerce worker: no handler for job kind', {
        jobId: job.id,
        orgId: job.orgId,
        kind: job.kind,
      });
      return;
    }

    let outcome: JobOutcome;
    try {
      outcome = await handler.handle(job);
    } catch (error) {
      // An unhandled exception means the handler did not decide, so the queue decides the cautious
      // way: retry. "We do not know what went wrong" is not grounds for dropping work a client was
      // promised, and `max_attempts` is what stops that from meaning forever.
      const reason = error instanceof Error ? error.message : String(error);
      Sentry.captureException(error);
      outcome = { kind: 'retry', reason: `handler threw: ${reason}` };
    }

    if (outcome.kind === 'done') {
      await jobRepository.markDone(job.id);
      logger.info('commerce worker: job done', {
        jobId: job.id,
        orgId: job.orgId,
        kind: job.kind,
        attempts: job.attempts,
      });
      return;
    }

    if (outcome.kind === 'failed') {
      await jobRepository.markTerminal(job.id, 'failed', outcome.reason);
      logger.warn('commerce worker: job failed permanently, not retrying', {
        jobId: job.id,
        orgId: job.orgId,
        kind: job.kind,
        reason: outcome.reason,
      });
      return;
    }

    // `attempts` was already incremented when this job was claimed, so it counts THIS attempt.
    if (job.attempts >= job.maxAttempts) {
      await jobRepository.markTerminal(job.id, 'dead', outcome.reason);
      // Loud, and to Sentry as well as the log. A dead job is work that was promised and did not
      // happen; it is the one queue event that should reach a person rather than a dashboard.
      Sentry.captureMessage(`commerce job exhausted its attempts: ${job.kind}`, 'error');
      logger.error('commerce worker: job dead after exhausting attempts', {
        jobId: job.id,
        orgId: job.orgId,
        kind: job.kind,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        reason: outcome.reason,
      });
      return;
    }

    const delay = backoffMs(job.attempts);
    await jobRepository.markForRetry(job.id, outcome.reason, new Date(Date.now() + delay));
    logger.warn('commerce worker: job will be retried', {
      jobId: job.id,
      orgId: job.orgId,
      kind: job.kind,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      retryInMs: delay,
      reason: outcome.reason,
    });
  }

  /** The timer's body: one pass, guarded so a slow batch can never stack on itself. */
  private async tick(): Promise<void> {
    if (this.draining || this.stopping) return;
    this.draining = true;
    try {
      const processed = await this.runOnce();
      if (processed > 0) {
        logger.info('commerce worker: pass complete', { processed });
      }
    } catch (error) {
      // Claiming failed — the database was restarting, or the connection pool was exhausted. Logged
      // and swallowed so the next tick still happens; rethrowing here would take down the only thing
      // draining the queue.
      Sentry.captureException(error);
      logger.error('commerce worker: pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.draining = false;
    }
  }

  /** Start polling. Returns a stop function for graceful shutdown. */
  start(): () => void {
    this.stopping = false;
    logger.info('commerce worker: starting', {
      workerId: this.workerId,
      pollMs: config.commerceWorker.pollMs,
      batchSize: config.commerceWorker.batchSize,
      leaseSeconds: config.commerceWorker.leaseSeconds,
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, config.commerceWorker.pollMs);
    this.timer.unref();

    return () => {
      this.stopping = true;
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}

export const commerceWorker = new CommerceWorker();
