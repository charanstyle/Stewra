import type { AuditEvent } from '../audit/events';
import type { Paginated } from '../common/base';

/**
 * Query the plain-language activity feed (a view over the append-only audit log).
 * `cursor` is explicitly null for the first page (never omitted); `limit` is always supplied.
 */
export interface ListActivityRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export type ListActivityResponse = Paginated<AuditEvent>;
