import type {
  GetEmailOverWhatsappResponse,
  SetEmailOverWhatsappResponse,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { userPreferencesRepository } from '../repositories/userPreferencesRepository.js';
import { authService } from './authService.js';
import { preferencesService } from './preferencesService.js';
import { ServiceUnavailableError } from '../utils/errors.js';

/**
 * A feature id, not a `MessagingChannel`. Approve-to-send is a capability layered over the existing
 * WhatsApp channels, not a channel of its own — but the audit rows still key on `resourceType: 'channel'`
 * with this id, because "the user turned a WhatsApp-adjacent capability on/off" is exactly what it records.
 */
const FEATURE_ID = 'whatsapp_email_approval';

/**
 * The gate for approve-to-send email over WhatsApp.
 *
 * The load-bearing rule of this feature lives in one method: turning the opt-in ON re-verifies the
 * account password, so a WhatsApp identity alone — the weaker factor this whole design distrusts — can
 * never enable it. Turning it OFF removes a capability and is deliberately frictionless (no password).
 * Nothing here ever sends email: this service only records the user's standing choice, which the two
 * WhatsApp channels then read to decide whether to offer approval instead of their draft-and-defer notice.
 */
class WhatsappEmailApprovalService {
  private assertEnabled(): void {
    if (!config.whatsappEmailApproval.enabled) {
      throw new ServiceUnavailableError('Sending email by WhatsApp is not available');
    }
  }

  /** GET state for the "Your sources" panel toggle. */
  async getStatus(userId: string): Promise<GetEmailOverWhatsappResponse> {
    const enabled = config.whatsappEmailApproval.enabled;
    // When the deploy kill-switch is off the capability does not exist, so report opted-in as false
    // regardless of any stored value — the UI must never present a disabled feature as active.
    const optedIn = enabled ? await preferencesService.sendEmailOverWhatsapp(userId) : false;
    return { enabled, optedIn };
  }

  /**
   * Turn the opt-in on or off. Enabling re-verifies the password (throws `AuthenticationError` on a bad
   * one, before anything is written); disabling needs none. Records the decision to the append-only audit
   * log either way.
   */
  async setEnabled(
    userId: string,
    enabled: boolean,
    password: string | undefined,
  ): Promise<SetEmailOverWhatsappResponse> {
    this.assertEnabled();

    if (enabled) {
      await authService.reverifyPassword(userId, password);
    }

    // First write of a preferences row needs a concrete lookback (NOT NULL, no DB default); supply the
    // effective one so flipping this opt-in never depends on a lookback having been set first.
    const lookbackForInsert = await preferencesService.gmailLookbackDays(userId);
    await userPreferencesRepository.upsertSendEmailOverWhatsapp(userId, enabled, lookbackForInsert);

    await auditWriter.write({
      userId,
      action: enabled ? 'consent' : 'disconnect',
      resourceType: 'channel',
      resourceId: FEATURE_ID,
      summary: enabled
        ? 'You turned on sending email by WhatsApp (approve-to-send), re-entering your password.'
        : 'You turned off sending email by WhatsApp.',
      success: true,
      metadata: { feature: FEATURE_ID },
    });

    return { optedIn: enabled };
  }
}

export const whatsappEmailApprovalService = new WhatsappEmailApprovalService();
