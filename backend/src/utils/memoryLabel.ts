import type { Rating, ResourceKind } from '@stewra/shared-types';
import { keywords } from './text.js';

/** Human-readable source name for a resource kind, used as the label's leading scope. */
const KIND_TITLE: Readonly<Record<ResourceKind, string>> = {
  calendar: 'Calendar',
  gmail: 'Gmail',
  money: 'Money',
  memory: 'Memory',
};

/** How many purpose keywords to keep in the label — enough to be recognizable, short enough to scan. */
const MAX_PHRASE_WORDS = 6;
const MAX_LABEL_LENGTH = 200;

/** Capitalize the first character of a non-empty string. */
function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build the human-meaningful, searchable NAME for a memory, deterministically, from the task. Shape:
 * "Calendar · weekly 1 1 with sam prep (outstanding)". The kind scopes it, the keyword phrase makes
 * it recognizable and lexically findable, and the rating shows how good the remembered result was.
 * The user can rename it later on the Memory screen.
 */
export function buildMemoryLabel(kind: ResourceKind, purpose: string, rating: Rating): string {
  const phraseWords = keywords(purpose).slice(0, MAX_PHRASE_WORDS);
  const phrase = phraseWords.length > 0 ? capitalizeFirst(phraseWords.join(' ')) : 'General';
  const label = `${KIND_TITLE[kind]} · ${phrase} (${rating})`;
  return label.length > MAX_LABEL_LENGTH ? label.slice(0, MAX_LABEL_LENGTH) : label;
}
