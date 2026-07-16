import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig.js';
import { whatsappStore } from '../repositories/whatsappStore.js';
import { logger } from '../utils/logger.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Keeps the WhatsApp store from growing past the window the operator configured, exactly as
 * `emailRetentionService` does for mail.
 *
 * This matters more here than it does for email. These are messages from OTHER PEOPLE, who never agreed
 * to anything and cannot see or delete what we hold about them. The only defensible posture is to keep as
 * little as we can for as short as we can — so the sweep is not housekeeping, it is the promise.
 */
class WhatsappRetentionService {
  /** Delete stored WhatsApp messages older than the retention window. */
  async sweepForUser(userId: string): Promise<number> {
    const cutoff = new Date(Date.now() - config.whatsappPersonal.retentionDays * MS_PER_DAY);
    const removed = await whatsappStore.deleteMessagesOlderThan(userId, cutoff);
    if (removed > 0) {
      logger.info('whatsappRetention: swept old messages', {
        userId,
        removed,
        days: config.whatsappPersonal.retentionDays,
      });
    }
    return removed;
  }

  /**
   * Sweep every user holding stored WhatsApp content. Runs on the scheduler tick.
   *
   * Per-user failures are captured and skipped rather than aborting the batch: one user's bad row must
   * not be the reason everyone else's data outlives its window.
   */
  async sweepAll(): Promise<void> {
    if (!config.whatsappPersonal.enabled) return;

    const userIds = await whatsappStore.userIdsWithStoredMessages();
    for (const userId of userIds) {
      try {
        await this.sweepForUser(userId);
      } catch (error) {
        Sentry.captureException(error);
        logger.error('whatsappRetention: per-user sweep failed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const whatsappRetentionService = new WhatsappRetentionService();
