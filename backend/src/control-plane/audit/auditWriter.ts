import type { AuditEvent, NewAuditEvent } from '@stewra/shared-types';
import { db } from '../../database/index';

/**
 * Appends to the immutable audit log. For a trust-first product there are NO unaudited actions:
 * if the write fails, this THROWS (we do not silently swallow). The table itself rejects any
 * later UPDATE/DELETE at the DB level.
 */
export class AuditWriter {
  async write(event: NewAuditEvent): Promise<AuditEvent> {
    const row = await db
      .insertInto('audit_log')
      .values({
        user_id: event.userId,
        action: event.action,
        resource_type: event.resourceType,
        resource_id: event.resourceId,
        summary: event.summary,
        success: event.success,
        metadata: JSON.stringify(event.metadata),
      })
      .returning([
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
      .executeTakeFirstOrThrow();

    return {
      id: row.id,
      userId: row.user_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      summary: row.summary,
      success: row.success,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
    };
  }
}

export const auditWriter = new AuditWriter();
