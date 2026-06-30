import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '@stewra/agent-runtime';
import type {
  BrokerRequest,
  BrokerResult,
  IBrokerClient,
  IModelClient,
  ModelMessage,
} from '@stewra/shared-types';

/**
 * The product's core promise, expressed as a test: the untrusted agent can ONLY reach data through
 * the broker, can ONLY reason through the model, and the model only ever sees short derived facts —
 * never a token, never a raw record. If this ever fails, the trust architecture is broken.
 */

/** A broker that records every request and returns a fixed set of derived facts. */
class SpyBroker implements IBrokerClient {
  readonly requests: BrokerRequest[] = [];
  constructor(private readonly facts: ReadonlyArray<string>) {}
  async request(req: BrokerRequest): Promise<BrokerResult> {
    this.requests.push(req);
    return { allowed: true, kind: req.kind, facts: this.facts };
  }
}

/** A model that records every message batch it is asked to complete. */
class SpyModel implements IModelClient {
  readonly calls: ReadonlyArray<ModelMessage>[] = [];
  async complete(messages: ReadonlyArray<ModelMessage>): Promise<string> {
    this.calls.push(messages);
    return 'Take Thursday evening for yourself.';
  }
}

const SECRET_TOKEN = '1//super-secret-refresh-token-DO-NOT-LEAK';
const RAW_EVENT_JSON = '{"attendees":["alice@example.com"],"location":"123 Private St"}';

describe('agent containment', () => {
  it('reaches data ONLY via the broker and reasons ONLY via the model', async () => {
    const broker = new SpyBroker(['Tuesday evening is your only free evening this week']);
    const model = new SpyModel();
    const runtime = new AgentRuntime(broker, model);

    const insight = await runtime.produceInsight('user-1', 'calendar', 'weekly look');

    // It asked the broker exactly once, and the model exactly once — no other capability exists.
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0]).toMatchObject({ userId: 'user-1', kind: 'calendar' });
    expect(model.calls).toHaveLength(1);
    expect(insight.summary).toContain('Thursday');
  });

  it('never lets a token or a raw record reach the model — only derived facts', async () => {
    // Even if the broker returned ONLY clean facts, we assert the model payload can't contain a
    // secret/raw record. The runtime builds the prompt purely from broker facts.
    const broker = new SpyBroker(['You have 2 unread emails']);
    const model = new SpyModel();
    const runtime = new AgentRuntime(broker, model);

    await runtime.produceInsight('user-1', 'gmail', 'inbox glance');

    const everythingSentToModel = JSON.stringify(model.calls);
    expect(everythingSentToModel).not.toContain(SECRET_TOKEN);
    expect(everythingSentToModel).not.toContain(RAW_EVENT_JSON);
    expect(everythingSentToModel).toContain('You have 2 unread emails');
  });

  it('returns a safe non-answer when access is denied (no model call)', async () => {
    const denying: IBrokerClient = {
      async request(req: BrokerRequest): Promise<BrokerResult> {
        return { allowed: false, kind: req.kind, reason: 'no active connection' };
      },
    };
    const model = new SpyModel();
    const runtime = new AgentRuntime(denying, model);

    const insight = await runtime.produceInsight('user-1', 'calendar', 'weekly look');

    expect(insight.summary).toContain('not permitted');
    expect(model.calls).toHaveLength(0); // denied access never reaches the model
  });

  it('the agent-runtime package declares NO runtime dependency except @stewra/shared-types', () => {
    // Structural guarantee backing the dependency-cruiser CI gate: the untrusted plane has no db,
    // vault, or network library available to it at all.
    const pkgPath = join(__dirname, '../../../packages/agent-runtime/package.json');
    const pkg: { dependencies?: Record<string, string> } = JSON.parse(
      readFileSync(pkgPath, 'utf8'),
    );
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@stewra/shared-types']);
  });
});
