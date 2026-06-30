import type { AuditEvent, ListActivityResponse } from '@stewra/shared-types';
import { db } from '../../database/index';

const MAX_LIMIT = 100;

/** Reads the audit log as the user-facing activity feed (newest first, cursor-paginated by id). */
export class AuditReader {
  async listForUser(userId: string, cursor: string | null, limit: number): Promise<ListActivityResponse> {
    const effectiveLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);

    let query = db
      .selectFrom('audit_log')
      .select([
        'id',
        'user_id',
        'action',
        'resource_type',
        'resource_id',
        'summary',
        'success',
        'metadata',
        'created_at',
      ])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(effectiveLimit + 1);

    if (cursor !== null) {
      query = query.where('id', '<', cursor);
    }

    const rows = await query.execute();
    const hasMore = rows.length > effectiveLimit;
    const page = hasMore ? rows.slice(0, effectiveLimit) : rows;

    const items: AuditEvent[] = page.map((row) => ({
      id: row.id,
      userId: row.user_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      summary: row.summary,
      success: row.success,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
    }));

    const last = page.length > 0 ? page[page.length - 1] : undefined;
    const nextCursor = hasMore && last !== undefined ? last.id : null;

    return { items, nextCursor };
  }
}

export const auditReader = new AuditReader();
