import type { ISODateString, UUID } from '../common/base';
import type { ResourceKind } from '../broker/contract';
import type { Rating } from './feedback';

/** How a memory came to exist: derived from the user's feedback, or added/edited by the user. */
export type MemorySource = 'feedback' | 'user_edited';

/**
 * A user-owned "learning" — the product's memory of what worked. `label` is the human-meaningful,
 * searchable NAME; `exemplar` is the high-rated result ("what good looks like"); `guidance` is the
 * distilled free-text ("how to do it"). Fully visible, editable, and deletable by the user
 * (memory-and-learning.md §5).
 */
export interface AgentMemory {
  readonly id: UUID;
  readonly label: string;
  readonly kind: ResourceKind;
  readonly purpose: string;
  readonly exemplar: string;
  readonly guidance: string | null;
  readonly rating: Rating;
  readonly rewardScore: number;
  readonly source: MemorySource;
  readonly visible: boolean;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
