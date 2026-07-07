import type {
  Suggestion,
  SuggestionKind,
  SuggestionOption,
  SuggestionSourceRef,
  SuggestionStatus,
} from '@stewra/shared-types';
import { db } from '../database/index';

/** Input to create/refresh a nudge, keyed by a stable `dedupKey` (e.g. "needs_reply:<threadId>"). */
export interface UpsertSuggestionInput {
  readonly dedupKey: string;
  readonly kind: SuggestionKind;
  readonly title: string;
  readonly rationale: string;
  readonly sourceRefs: ReadonlyArray<SuggestionSourceRef>;
  readonly options: ReadonlyArray<SuggestionOption>;
}

interface SuggestionDbRow {
  id: string;
  kind: SuggestionKind;
  title: string;
  rationale: string;
  source_refs: ReadonlyArray<SuggestionSourceRef>;
  options: ReadonlyArray<SuggestionOption>;
  status: SuggestionStatus;
  snoozed_until: Date | null;
  created_at: Date;
}

/**
 * Data access for suggestions (nudges). The `dedup_key` unique per user gives each nudge a stable
 * identity so a re-computation UPDATES an open one in place and — via the `WHERE status = 'open'`
 * guard on conflict — never clobbers one the user already acted on (dismissed/snoozed/done).
 */
export class SuggestionRepository {
  /** Create or refresh a nudge; a user-acted row (not 'open') is left untouched. */
  async upsertByDedup(userId: string, input: UpsertSuggestionInput): Promise<void> {
    await db
      .insertInto('suggestions')
      .values({
        user_id: userId,
        dedup_key: input.dedupKey,
        kind: input.kind,
        title: input.title,
        rationale: input.rationale,
        source_refs: JSON.stringify(input.sourceRefs),
        options: JSON.stringify(input.options),
      })
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'dedup_key'])
          .doUpdateSet({
            kind: input.kind,
            title: input.title,
            rationale: input.rationale,
            source_refs: JSON.stringify(input.sourceRefs),
            options: JSON.stringify(input.options),
            updated_at: new Date(),
          })
          .where('suggestions.status', '=', 'open'),
      )
      .execute();
  }

  /** Open nudges plus any snoozed ones now due, newest first. */
  async listOpen(userId: string): Promise<ReadonlyArray<Suggestion>> {
    const now = new Date();
    const rows = await db
      .selectFrom('suggestions')
      .selectAll()
      .where('user_id', '=', userId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'open'),
          eb.and([eb('status', '=', 'snoozed'), eb('snoozed_until', '<=', now)]),
        ]),
      )
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toSuggestion);
  }

  async findByIdForUser(id: string, userId: string): Promise<Suggestion | undefined> {
    const row = await db
      .selectFrom('suggestions')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? toSuggestion(row) : undefined;
  }

  /** Set a nudge's status (+ optional snooze time), scoped to the owner. */
  async setStatus(
    id: string,
    userId: string,
    status: SuggestionStatus,
    snoozedUntil: Date | null,
  ): Promise<Suggestion> {
    const row = await db
      .updateTable('suggestions')
      .set({ status, snoozed_until: snoozedUntil, updated_at: new Date() })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSuggestion(row);
  }
}

function toSuggestion(row: SuggestionDbRow): Suggestion {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    rationale: row.rationale,
    sourceRefs: row.source_refs,
    options: row.options,
    status: row.status,
    snoozedUntil: row.snoozed_until ? row.snoozed_until.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export const suggestionRepository = new SuggestionRepository();
