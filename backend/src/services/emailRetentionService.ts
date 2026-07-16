import * as Sentry from '@sentry/node';
import { vault } from '../control-plane/vault/vault.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { preferencesService } from './preferencesService.js';
import { emailMessageRepository, purgeConnectionEmailData } from '../repositories/emailStore.js';
import { logger } from '../utils/logger.js';

/** A retention window at or above this many days is treated as "keep everything" — no sweep. */
const KEEP_ALL_THRESHOLD_DAYS = 36500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Enforces the email retention window and the disconnect purge. The store never grows past what the
 * user allowed: the sweep deletes messages older than their window; disconnect wipes everything
 * derived from that source, including the vaulted contact addresses.
 */
class EmailRetentionService {
  /** Delete stored messages older than the user's retention window. No-op for "keep all". */
  async sweepForUser(userId: string): Promise<number> {
    const days = await preferencesService.emailRetentionDays(userId);
    if (days >= KEEP_ALL_THRESHOLD_DAYS) {
      return 0;
    }
    const cutoff = new Date(Date.now() - days * MS_PER_DAY);
    const removed = await emailMessageRepository.deleteOlderThan(userId, cutoff);
    if (removed > 0) {
      logger.info('emailRetention: swept old messages', { userId, removed, days });
    }
    return removed;
  }

  /**
   * Forget everything stored for a disconnected connection: purge the email store rows and delete the
   * vaulted contact addresses. Writes a `forget` audit row so the removal is as visible as the sync.
   */
  async forgetForDisconnectedConnection(userId: string, connectionId: string): Promise<void> {
    const contactRefs = await purgeConnectionEmailData(connectionId);
    for (const ref of contactRefs) {
      try {
        await vault.delete(ref);
      } catch (error) {
        Sentry.captureException(error);
      }
    }
    await auditWriter.write({
      userId,
      action: 'forget',
      resourceType: 'email',
      resourceId: connectionId,
      summary: 'Deleted all stored email for the disconnected account',
      success: true,
      metadata: { connectionId, contactsForgotten: contactRefs.length },
    });
  }
}

export const emailRetentionService = new EmailRetentionService();
