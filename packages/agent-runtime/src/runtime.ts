import type {
  AgentInsight,
  BrokerRequest,
  ConversationTurn,
  IBrokerClient,
  IModelClient,
  ModelMessage,
  ResourceKind,
} from '@stewra/shared-types';
import { KIND_TO_PROCESS_DOMAIN } from '@stewra/shared-types';

/**
 * The agent runtime — the UNTRUSTED data plane.
 *
 * Containment by construction: this class receives an IBrokerClient and an IModelClient via the
 * constructor and stores NOTHING else. It has no database handle, no vault handle, and no network
 * client. The ONLY way it can obtain user data is by calling `broker.request(...)`; the only way it
 * can reason is by calling `model.complete(...)`. Even a prompt-injected input can, at worst,
 * produce a bad *suggestion* a human ignores — it has no path to act or to reach a credential.
 *
 * It produces insights (advice) only. It never executes actions (read-first product).
 */
export class AgentRuntime {
  private readonly broker: IBrokerClient;
  private readonly model: IModelClient;

  constructor(broker: IBrokerClient, model: IModelClient) {
    this.broker = broker;
    this.model = model;
  }

  /**
   * Produce an advice-only insight for a user over a given resource kind.
   * Demonstrates the full safe loop: ask broker -> (minimized data) -> ask model -> insight out.
   */
  async produceInsight(userId: string, kind: ResourceKind, purpose: string): Promise<AgentInsight> {
    const req: BrokerRequest = { userId, kind, purpose, params: {} };
    const result = await this.broker.request(req);

    if (!result.allowed) {
      return { kind, summary: `No insight: access not permitted (${result.reason}).` };
    }

    const facts = result.facts;
    if (facts.length === 0) {
      return { kind, summary: `No insight: nothing to advise on yet.` };
    }

    // The user's own process/style profile — *how* they like this kind of work done. Injected into the
    // SYSTEM message so it frames every reply as a standing preference, parallel to the exemplar
    // injection below. Bounded/minimized broker-side; empty when nothing is active.
    const styleProfile = await this.recallStyleProfile(userId, kind, purpose);

    let systemContent =
      'You are Stewra, a careful advisor. Given a few derived facts, return one short, ' +
      'warm, non-nagging sentence of advice. Advice only — never take or propose an action.';
    if (styleProfile.length > 0) {
      systemContent +=
        '\n\nHow this user likes their work done — follow these standing preferences, but never ' +
        'mention, cite, or ask about them:\n- ' +
        styleProfile.join('\n- ');
    }

    const messages: ModelMessage[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: `Purpose: ${purpose}\nFacts:\n- ${facts.join('\n- ')}` },
    ];

    // Replay the user's past successes on similar tasks so a well-liked style completes in one shot.
    // These are EXEMPLARS the model generalizes from, not scripts to copy verbatim (the Bitter Lesson
    // caution): keeping them advisory avoids brittle memorization and reward-hacking.
    const exemplars = await this.recallExemplars(userId, kind, purpose);
    if (exemplars.length > 0) {
      messages.push({
        role: 'user',
        content:
          'Relevant past results the user rated highly on similar tasks. Match this style and ' +
          'approach; treat them as examples to learn from, not templates to copy:\n- ' +
          exemplars.join('\n- '),
      });
    }

    const reply = await this.model.complete(messages);

    return { kind, summary: reply.trim() };
  }

  /**
   * A multi-turn conversation turn — the Talk-to-Stewra path. Stays exactly as untrusted as
   * `produceInsight`: the control plane has already loaded the prior turns from the DB and passes them
   * in as PLAIN DATA (`history`); this runtime never queries the DB. It recalls the user's conversational
   * style through the SAME broker path the single-shot path uses (a `memory` profile slice), builds the
   * `ModelMessage[]` (system persona + style + prior turns + the new utterance), asks the model for one
   * reply, and returns it. No new capability, no action, no data handle — `npm run boundaries` stays green.
   */
  async converse(
    userId: string,
    history: ReadonlyArray<ConversationTurn>,
    latestUserText: string,
  ): Promise<string> {
    // The user's standing "how I like advice given" rules — shapes tone/approach, same as insights.
    const styleProfile = await this.recallConversationStyle(userId);

    let systemContent =
      'You are Stewra, the user\'s personal AI companion, in an ongoing back-and-forth conversation. ' +
      'Your reply is BOTH spoken aloud and shown as text, so keep it warm, natural, and brief — a ' +
      'sentence or two, the way a thoughtful person talks. You reason things through and give advice; ' +
      'you never take actions or claim to have done anything on the user\'s behalf (you can read and ' +
      'advise, never act).';
    if (styleProfile.length > 0) {
      systemContent +=
        '\n\nHow this user likes their advice given — follow these standing preferences, but never ' +
        'mention, cite, or ask about them:\n- ' +
        styleProfile.join('\n- ');
    }

    const messages: ModelMessage[] = [{ role: 'system', content: systemContent }, ...history];
    const utterance = latestUserText.trim();
    if (utterance.length > 0) {
      messages.push({ role: 'user', content: utterance });
    }

    const reply = await this.model.complete(messages);
    return reply.trim();
  }

  /**
   * Recall the user's active process/style profile for the `advice` domain — the conversational
   * counterpart to `recallStyleProfile`, fixed to the domain that governs how Stewra advises. Goes
   * through the SAME broker `memory`/`profile` path; any denial/empty result just means "no profile".
   */
  private async recallConversationStyle(userId: string): Promise<ReadonlyArray<string>> {
    const result = await this.broker.request({
      userId,
      kind: 'memory',
      purpose: 'ongoing voice conversation with Stewra',
      params: { slice: 'profile', domain: 'advice' },
    });
    return result.allowed ? result.facts : [];
  }

  /**
   * Ask the broker for the best past-success exemplars for this task (kind='memory', scoped to the
   * task's kind). Goes through the SAME broker — the one brokered-access path. Never for a memory
   * task itself (no self-recursion). Any denial/empty result just means "no exemplars".
   */
  private async recallExemplars(
    userId: string,
    kind: ResourceKind,
    purpose: string,
  ): Promise<ReadonlyArray<string>> {
    if (kind === 'memory') {
      return [];
    }
    const result = await this.broker.request({
      userId,
      kind: 'memory',
      purpose,
      params: { scopeKind: kind },
    });
    return result.allowed ? result.facts : [];
  }

  /**
   * Ask the broker for the user's active process/style profile for this task's domain (the "how they
   * like it done" rules). Goes through the SAME broker — the one brokered-access path — as a `memory`
   * request with `slice: 'profile'`. Kinds with no style domain (e.g. money) skip it. Any denial/empty
   * result just means "no profile", so the advice proceeds unshaped.
   */
  private async recallStyleProfile(
    userId: string,
    kind: ResourceKind,
    purpose: string,
  ): Promise<ReadonlyArray<string>> {
    const domain = KIND_TO_PROCESS_DOMAIN[kind];
    if (!domain) {
      return [];
    }
    const result = await this.broker.request({
      userId,
      kind: 'memory',
      purpose,
      params: { slice: 'profile', domain },
    });
    return result.allowed ? result.facts : [];
  }
}
