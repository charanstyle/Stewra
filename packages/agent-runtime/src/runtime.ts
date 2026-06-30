import type {
  AgentInsight,
  BrokerRequest,
  IBrokerClient,
  IModelClient,
  ResourceKind,
} from '@stewra/shared-types';

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

    const reply = await this.model.complete([
      {
        role: 'system',
        content:
          'You are Stewra, a careful advisor. Given a few derived facts, return one short, ' +
          'warm, non-nagging sentence of advice. Advice only — never take or propose an action.',
      },
      { role: 'user', content: `Purpose: ${purpose}\nFacts:\n- ${facts.join('\n- ')}` },
    ]);

    return { kind, summary: reply.trim() };
  }
}
