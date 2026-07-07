import type { ISODateString, UUID } from '../common/base';
import type { Suggestion } from '../models/suggestion';

/** GET /home/suggestions — the user's open (+ snoozed-but-due) nudges, newest first. */
export interface ListSuggestionsResponse {
  readonly suggestions: ReadonlyArray<Suggestion>;
}

/** POST /home/suggestions/:id/snooze — defer a nudge until `until`. */
export interface SnoozeSuggestionRequest {
  readonly until: ISODateString;
}
export interface SnoozeSuggestionResponse {
  readonly suggestion: Suggestion;
}

/** POST /home/suggestions/:id/dismiss — decline a nudge (implicit negative signal). */
export interface DismissSuggestionResponse {
  readonly suggestion: Suggestion;
}

/** POST /home/suggestions/:id/done — mark a nudge handled without an executed action. */
export interface MarkSuggestionDoneResponse {
  readonly suggestion: Suggestion;
}

/**
 * POST /home/suggestions/:id/draft — ask Stewra to draft a reply for the thread behind a
 * `reply_email` option, in the user's learned style. Read-only: returns text for review, never sends.
 * `addedInfo` folds in any extra instruction the user typed into the card.
 */
export interface RequestDraftRequest {
  readonly optionId?: UUID;
  readonly addedInfo?: string;
}
export interface RequestDraftResponse {
  readonly draft: string;
}

/**
 * POST /home/suggestions/:id/chat — open a conversation with Stewra seeded from this nudge. The
 * control plane injects a pre-filled user turn (the nudge context + any `message`) into the singleton
 * Stewra-AI conversation and returns its id so the client can deep-link into /stewra.
 */
export interface ChatAboutSuggestionRequest {
  readonly message?: string;
}
export interface ChatAboutSuggestionResponse {
  readonly conversationId: UUID;
}
