import type { Briefing, BriefingSection } from '@stewra/shared-types';
import { db } from '../database/index';

interface BriefingDbRow {
  id: string;
  summary: string;
  sections: ReadonlyArray<BriefingSection>;
  generated_at: Date;
}

/** Data access for the one-current-briefing-per-user store (migration 026). */
export class BriefingRepository {
  /** Insert-or-replace the user's current briefing. */
  async upsertForUser(
    userId: string,
    summary: string,
    sections: ReadonlyArray<BriefingSection>,
  ): Promise<Briefing> {
    const generatedAt = new Date();
    const row = await db
      .insertInto('briefings')
      .values({
        user_id: userId,
        summary,
        sections: JSON.stringify(sections),
        generated_at: generatedAt,
      })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({
          summary,
          sections: JSON.stringify(sections),
          generated_at: generatedAt,
        }),
      )
      .returning(['id', 'summary', 'sections', 'generated_at'])
      .executeTakeFirstOrThrow();
    return toBriefing(row);
  }

  async getForUser(userId: string): Promise<Briefing | null> {
    const row = await db
      .selectFrom('briefings')
      .select(['id', 'summary', 'sections', 'generated_at'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? toBriefing(row) : null;
  }
}

function toBriefing(row: BriefingDbRow): Briefing {
  return {
    id: row.id,
    summary: row.summary,
    sections: row.sections,
    generatedAt: row.generated_at.toISOString(),
  };
}

export const briefingRepository = new BriefingRepository();
