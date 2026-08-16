import * as Sentry from '@sentry/node';
import { channelTokenService } from '../services/channelTokenService.js';
import { commerceWorker } from '../jobs/worker.js';
import { enqueueTemplateSyncs } from '../jobs/templateSyncHandler.js';
import { enqueueMessageCostBackfills } from '../jobs/messageCostBackfillHandler.js';
import { enqueueBillingPeriodCloses } from '../jobs/billingPeriodCloseHandler.js';
import { enqueueInvoiceCharges } from '../jobs/invoiceChargeHandler.js';
import { config } from '../../config/unifiedConfig.js';
import { logger } from '../../utils/logger.js';

/**
 * The commerce plane's background work. Its own starter rather than a branch inside
 * `scheduler/scheduler.ts`, for the same reason the context has its own tables: that file belongs to
 * the personal-assistant plane, and the import boundary in `.dependency-cruiser.cjs` is what keeps
 * the two from growing into each other.
 *
 * Two things start here, and the division between them is the point:
 *
 *  - **A timer that decides what needs doing.** Hourly, it looks for credentials nearing their
 *    deadline and puts one job on the queue per account.
 *  - **The worker that does it.** Polling `commerce_jobs`, with retries, backoff and a ceiling.
 *
 * The timer used to do both, and could not retry. Everything it decided either happened on that tick
 * or was lost until the next one, with no record that it had been attempted — survivable for a
 * credential with sixty days of runway, and not survivable for the campaign sends this queue exists
 * to carry.
 */

let tokenTimer: NodeJS.Timeout | null = null;
let templateTimer: NodeJS.Timeout | null = null;
let billingTimer: NodeJS.Timeout | null = null;
let sweeping = false;
let syncing = false;
let billing = false;

/**
 * How often credentials are checked. Hourly, and deliberately not an env knob.
 *
 * The WINDOW that matters — how long before expiry a renewal is attempted — is seven days, so the
 * cadence is only how finely that window is honoured, and an hour honours a week precisely enough.
 * A tunable here would be nothing but a way to switch off the thing standing between a client and a
 * channel that stops working on day 60.
 */
const TOKEN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Queue a renewal for each credential nearing expiry. Guarded so a slow pass cannot stack on itself. */
async function tokenSweep(): Promise<void> {
  if (sweeping) {
    logger.info('commerce scheduler: previous credential sweep still running, skipping');
    return;
  }
  sweeping = true;
  try {
    await channelTokenService.enqueueDueRefreshes();
  } catch (error) {
    // Captured and swallowed rather than rethrown: the sweep runs unattended, and one hour where the
    // database was restarting must not stop the next hour from running.
    Sentry.captureException(error);
    logger.error('commerce scheduler: credential sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    sweeping = false;
  }
}

/**
 * How often every connected WABA's templates are re-read from Meta.
 *
 * Hourly, and this cadence IS the guarantee rather than a refinement of one. Meta announces a pause,
 * a deletion or a re-categorization by webhook, and a webhook it failed to deliver leaves a template
 * looking sendable with nothing to correct it. An hour is the longest a campaign can go out under a
 * status Meta has already revoked.
 */
const TEMPLATE_SYNC_INTERVAL_MS = 60 * 60 * 1000;

/** Queue a template re-read for each connected account. Guarded the same way the token sweep is. */
async function templateSync(): Promise<void> {
  if (syncing) {
    logger.info('commerce scheduler: previous template sync still running, skipping');
    return;
  }
  syncing = true;
  try {
    await enqueueTemplateSyncs();
  } catch (error) {
    Sentry.captureException(error);
    logger.error('commerce scheduler: template sync sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    syncing = false;
  }
}

/**
 * How often billing self-heals and closes. Hourly, and the cadence carries meaning here too: a
 * billing period is monthly, but the SWEEP must be hourly because it is also the retry loop — an
 * open period (unpriced messages holding a draft) is re-attempted every hour until the backfill
 * has priced the stragglers, and "your invoice issues within the hour of the data completing" is
 * the promise. The two enqueuers run in one tick, backfill first, so a straggler priced on this
 * pass can close its period on this pass's own close job rather than waiting another hour.
 *
 * Read from config rather than fixed here so the browser suite can watch a subscription become an
 * invoice and an invoice become a charge inside a test's lifetime. Everything downstream is
 * idempotent, so the cadence is a latency knob and not a correctness one.
 */
const BILLING_SWEEP_INTERVAL_MS = config.commerceWorker.billingSweepMs;

/**
 * Queue the cost backfills, then the period billing, then collection. Guarded like the other
 * sweeps.
 *
 * The order is the money's order and matters on the hour a month turns over: an invoice has to
 * exist before anything can collect it, so billing runs ahead of collection and the new period's
 * invoice is charged on the same pass that creates it rather than an hour later.
 */
async function billingSweep(): Promise<void> {
  if (billing) {
    logger.info('commerce scheduler: previous billing sweep still running, skipping');
    return;
  }
  billing = true;
  try {
    await enqueueMessageCostBackfills();
    await enqueueBillingPeriodCloses();
    await enqueueInvoiceCharges();
  } catch (error) {
    Sentry.captureException(error);
    logger.error('commerce scheduler: billing sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    billing = false;
  }
}

/**
 * Start the commerce timers. Returns a stop function for graceful shutdown.
 *
 * Tied to `metaCommerce.enabled` and nothing else. There is no credential to renew when the
 * integration is off, and hanging it off an unrelated switch is how someone eventually turns off
 * expiry handling by turning off something they thought was separate.
 *
 * A first pass runs immediately rather than waiting an hour: a deploy that has been down over a
 * weekend may come up with credentials already past their deadline, and an hour of a client being
 * told nothing is an hour they could have spent reconnecting.
 */
export function startCommerceScheduler(): () => void {
  if (!config.metaCommerce.enabled) {
    logger.info('commerce scheduler: disabled (META_COMMERCE_ENABLED=false)');
    return () => undefined;
  }

  // The worker starts FIRST, and unconditionally alongside the enqueuers. A deploy that enqueues
  // without draining looks healthy — every enqueue succeeds — while the work silently piles up, so
  // there is deliberately no separate switch that could leave those two apart.
  const stopWorker = commerceWorker.start();

  logger.info('commerce scheduler: channel credential sweep enabled');
  void tokenSweep();
  tokenTimer = setInterval(() => {
    void tokenSweep();
  }, TOKEN_SWEEP_INTERVAL_MS);
  tokenTimer.unref();

  logger.info('commerce scheduler: template sync enabled');
  void templateSync();
  templateTimer = setInterval(() => {
    void templateSync();
  }, TEMPLATE_SYNC_INTERVAL_MS);
  templateTimer.unref();

  logger.info('commerce scheduler: billing sweep enabled');
  void billingSweep();
  billingTimer = setInterval(() => {
    void billingSweep();
  }, BILLING_SWEEP_INTERVAL_MS);
  billingTimer.unref();

  return () => {
    if (tokenTimer !== null) {
      clearInterval(tokenTimer);
      tokenTimer = null;
    }
    if (templateTimer !== null) {
      clearInterval(templateTimer);
      templateTimer = null;
    }
    if (billingTimer !== null) {
      clearInterval(billingTimer);
      billingTimer = null;
    }
    stopWorker();
  };
}
