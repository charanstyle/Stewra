import type { Suggestion } from '@stewra/shared-types';
import { auditWriter } from '../control-plane/audit/auditWriter';
import { suggestionRepository } from '../repositories/suggestionRepository';
import { NotFoundError } from '../utils/errors';

/**
 * The nudge lifecycle service — the propose→confirm surface generalized from process rules. The
 * background job proposes nudges; the user snoozes/dismisses/marks-done here. Every transition is
 * audited so the activity feed stays honest about what Stewra surfaced and what the user did with it.
 */
class SuggestionService {
  /** Open nudges (plus snoozed-but-due), newest first. */
  async listOpen(userId: string): Promise<ReadonlyArray<Suggestion>> {
    return suggestionRepository.listOpen(userId);
  }

  private async requireOwned(id: string, userId: string): Promise<Suggestion> {
    const existing = await suggestionRepository.findByIdForUser(id, userId);
    if (existing === undefined) {
      throw new NotFoundError('Suggestion not found');
    }
    return existing;
  }

  /** Defer a nudge until `until`. */
  async snooze(userId: string, id: string, until: Date): Promise<Suggestion> {
    const existing = await this.requireOwned(id, userId);
    const suggestion = await suggestionRepository.setStatus(id, userId, 'snoozed', until);
    await auditWriter.write({
      userId,
      action: 'snooze',
      resourceType: 'suggestion',
      resourceId: id,
      summary: `Snoozed "${existing.title}"`,
      success: true,
      metadata: { until: until.toISOString() },
    });
    return suggestion;
  }

  /** Decline a nudge (implicit negative signal). */
  async dismiss(userId: string, id: string): Promise<Suggestion> {
    const existing = await this.requireOwned(id, userId);
    const suggestion = await suggestionRepository.setStatus(id, userId, 'dismissed', null);
    await auditWriter.write({
      userId,
      action: 'dismiss',
      resourceType: 'suggestion',
      resourceId: id,
      summary: `Dismissed "${existing.title}"`,
      success: true,
      metadata: {},
    });
    return suggestion;
  }

  /** Mark a nudge handled (without an executed action). */
  async markDone(userId: string, id: string): Promise<Suggestion> {
    const existing = await this.requireOwned(id, userId);
    const suggestion = await suggestionRepository.setStatus(id, userId, 'done', null);
    await auditWriter.write({
      userId,
      action: 'suggest',
      resourceType: 'suggestion',
      resourceId: id,
      summary: `Marked "${existing.title}" done`,
      success: true,
      metadata: {},
    });
    return suggestion;
  }
}

export const suggestionService = new SuggestionService();
