import type { ConversationTurn, ProposedCommerceReply } from '@stewra/shared-types';
import { logger } from '../utils/logger.js';

/**
 * An extension point that lets a bounded context claim a Talk-to-Stewra turn.
 *
 * It lives in `ports/` rather than in either plane because `.dependency-cruiser.cjs` forbids the two
 * planes from importing each other in BOTH directions: `commerce-no-personal-assistant` stops
 * `backend/src/commerce/` reaching `services/` or `repositories/`, and `personal-assistant-no-commerce`
 * stops everything outside commerce reaching into it. A port either side may import is the only shape
 * that satisfies both, and that constraint is a feature — it is what keeps a `user_id`-scoped path
 * from quietly acquiring an `org_id`-scoped dependency.
 *
 * The reason it has to exist at all: the headline product decision is that a business runs its
 * commercial funnel BY TEXTING STEWRA. That text arrives on the personal-assistant plane's WhatsApp
 * channel and flows through `stewraConversationService`, which must therefore be able to offer the
 * turn to the commerce plane without knowing that the commerce plane exists. So the dependency is
 * inverted: this file declares the port, commerce implements it, and the composition root
 * (`index.ts`) registers the implementation.
 *
 * Registered handlers get the turn AFTER the runner tool and BEFORE the advice-only agent.
 */

/** A still-`pending` commerce proposal and the assistant message carrying it. */
export interface PendingCommerceProposal {
  readonly messageId: string;
  readonly proposal: ProposedCommerceReply;
}

/**
 * Everything a handler is given about the turn.
 *
 * Note what is NOT here: no repository, no database handle, no `user_id`-scoped service, and no
 * channel identity. A handler receives data plus one narrow capability ({@link settle}). A handler
 * that could reach a personal-assistant repository would have re-created the very leak the boundary
 * rules prevent, so the port hands over the minimum that makes the feature work.
 */
export interface TurnIntentRequest {
  readonly userId: string;
  /** The personal-assistant conversation the turn arrived in — NOT a commerce conversation. */
  readonly conversationId: string;
  readonly history: ReadonlyArray<ConversationTurn>;
  readonly latestUserText: string;
  /** The newest pending proposal in this conversation, so a bare "yes" has something to resolve. */
  readonly pending: PendingCommerceProposal | null;
  /**
   * Move a pending proposal to a terminal state (`sent`/`failed`/`cancelled`). Handed in as a
   * function so a handler can record an outcome without holding `messageRepository`.
   */
  readonly settle: (messageId: string, proposal: ProposedCommerceReply) => Promise<void>;
}

/**
 * What a handler produces when it claims the turn: the line to say back on whatever channel the user
 * asked from, and — only for a fresh or revised proposal — a still-`pending` proposal for the caller
 * to attach to the assistant message, so a button-bearing surface renders a Send/Cancel card too.
 */
export interface TurnIntentOutcome {
  readonly reply: string;
  readonly proposal: ProposedCommerceReply | null;
}

export interface TurnIntentHandler {
  /** Used in logs to say which handler claimed or failed a turn. */
  readonly name: string;
  /** Return null to pass — the turn then falls through to the next handler, then to the agent. */
  handle(request: TurnIntentRequest): Promise<TurnIntentOutcome | null>;
}

class TurnIntentRegistry {
  private readonly handlers: TurnIntentHandler[] = [];

  /**
   * Register a handler. Idempotent by name, so a double registration (a test that re-imports the
   * composition root, say) cannot make one handler answer the same turn twice.
   */
  register(handler: TurnIntentHandler): void {
    const existing = this.handlers.findIndex((h) => h.name === handler.name);
    if (existing >= 0) {
      this.handlers[existing] = handler;
      return;
    }
    this.handlers.push(handler);
  }

  /** Drop all handlers. For tests that need a turn to reach the agent untouched. */
  reset(): void {
    this.handlers.length = 0;
  }

  get size(): number {
    return this.handlers.length;
  }

  /**
   * Offer the turn to each handler in registration order; the first non-null outcome wins.
   *
   * A handler that THROWS is logged and skipped rather than allowed to fail the turn. This is a
   * genuine recovery, not a swallowed error: the fallback is an ordinary conversational reply, the
   * user still gets an answer, and the cause is on the record at `warn` with the handler named. The
   * alternative — a classifier bug breaking every chat turn, including ones with nothing to do with
   * commerce — is strictly worse. Crucially, nothing is EXECUTED on this path: a handler only ever
   * proposes, so a failure here can never mean a message went out uncertainly.
   */
  async dispatch(request: TurnIntentRequest): Promise<TurnIntentOutcome | null> {
    for (const handler of this.handlers) {
      try {
        const outcome = await handler.handle(request);
        if (outcome !== null) return outcome;
      } catch (error) {
        logger.warn('turn-intent handler failed; falling through to the next reply path', {
          handler: handler.name,
          userId: request.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  }
}

export const turnIntentRegistry = new TurnIntentRegistry();

/**
 * What the APP's Send/Cancel buttons ask of the plane that owns the proposal.
 *
 * A proposal can be answered two ways — by texting "yes", or by tapping a button on the card in the
 * chat thread — and both have to run the SAME code. If they diverge, one of them eventually loses a
 * gate the other kept, and the one that loses it is the one nobody re-reads.
 *
 * Kept separate from {@link TurnIntentHandler} because the trigger is different in kind: a handler is
 * offered a turn and decides whether to claim it, whereas this is a direct instruction naming a
 * proposal that already exists. Same seam, same types, different question.
 */
export interface ProposalExecutionRequest {
  readonly userId: string;
  readonly messageId: string;
  /** The proposal as stored, already checked to be answerable by the caller. */
  readonly proposal: ProposedCommerceReply;
  readonly action: 'send' | 'cancel';
  readonly settle: (messageId: string, proposal: ProposedCommerceReply) => Promise<void>;
}

export interface CommerceProposalExecutor {
  /** Throws on a failed send, having first recorded the failure on the proposal. Never swallows. */
  execute(request: ProposalExecutionRequest): Promise<void>;
}

class CommerceProposalExecutorRegistry {
  private executor: CommerceProposalExecutor | null = null;

  register(executor: CommerceProposalExecutor): void {
    this.executor = executor;
  }

  reset(): void {
    this.executor = null;
  }

  get registered(): boolean {
    return this.executor !== null;
  }

  /**
   * The executor, or a thrown error naming why there is none.
   *
   * Deliberately not a null return with a quiet no-op at the call site: a user tapping Send on a card
   * and getting a silent nothing cannot tell that from a message that went out. The only honest
   * answers are "it sent" and a stated reason it did not.
   */
  require(): CommerceProposalExecutor {
    if (this.executor === null) {
      throw new Error(
        'No commerce proposal executor is registered — the commerce plane is not wired into this ' +
          'process, so a business reply cannot be sent from here.',
      );
    }
    return this.executor;
  }
}

export const commerceProposalExecutorRegistry = new CommerceProposalExecutorRegistry();
