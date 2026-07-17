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
 * The whole activation rule, as a pure function: approve-to-send is live for a user only when the deploy
 * kill-switch is on AND that user opted in. Two independent switches, both required, neither sufficient.
 *
 * It is a named function rather than an inline `&&` so the rule can be tested exhaustively without a
 * database, and so the asymmetry has somewhere to be written down: the per-user opt-in is consent, while
 * the kill-switch is our ability to retract the feature from everyone at once, without a deploy. A
 * kill-switch that only blocked NEW opt-ins would retract nothing from the users who already opted in —
 * which is precisely the population it exists to protect.
 */
export function resolveApproveToSend(killSwitchEnabled: boolean, optedIn: boolean): boolean {
  return killSwitchEnabled && optedIn;
}

/**
 * The gate for approve-to-send email over WhatsApp.
 *
 * The load-bearing rule of this feature lives in one method: turning the opt-in ON re-verifies the
 * account password, so a WhatsApp identity alone — the weaker factor this whole design distrusts — can
 * never enable it. Turning it OFF removes a capability and is deliberately frictionless (no password).
 * Nothing here ever sends email: this service only records the user's standing choice, which the two
 * WhatsApp channels then read — via `isActiveFor` — to decide whether to offer approval instead of their
 * draft-and-defer notice.
 */
class WhatsappEmailApprovalService {
  private assertEnabled(): void {
    if (!config.whatsappEmailApproval.enabled) {
      throw new ServiceUnavailableError('Sending email by WhatsApp is not available');
    }
  }

  /**
   * Whether approve-to-send is actually live for this user right now — the ONE question every caller in
   * the data path should ask, and the reason none of them reads the bare preference.
   *
   * Callers must not reconstruct this from `preferencesService.sendEmailOverWhatsapp` plus a config check
   * of their own: that spreads the kill-switch across every new call site and makes it true only of the
   * sites someone remembered. Ask here instead and the switch stays authoritative by construction.
   */
  async isActiveFor(userId: string): Promise<boolean> {
    const killSwitchEnabled = config.whatsappEmailApproval.enabled;
    // Skip the query when the feature is retracted — there is no user-specific question to ask, and the
    // answer must not depend on the database being reachable. `resolveApproveToSend` still has the last
    // word, so the rule the tests pin is the rule that actually runs.
    const optedIn = killSwitchEnabled ? await preferencesService.sendEmailOverWhatsapp(userId) : false;
    return resolveApproveToSend(killSwitchEnabled, optedIn);
  }

  /** GET state for the "Your sources" panel toggle. */
  async getStatus(userId: string): Promise<GetEmailOverWhatsappResponse> {
    // `optedIn` reports the EFFECTIVE state, not the stored bit: the UI must never present a feature the
    // kill-switch has retracted as active.
    return { enabled: config.whatsappEmailApproval.enabled, optedIn: await this.isActiveFor(userId) };
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
