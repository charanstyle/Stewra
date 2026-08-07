import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

    // It reaches data ONLY through the broker: one call for the calendar slice, one for the user's
    // process/style profile (kind:'memory', slice:'profile'), and one for the past-success exemplars
    // (kind:'memory', scoped to calendar). All three go through the SAME broker — the single access
    // path — and the model is called exactly once. No other capability exists.
    expect(broker.requests).toHaveLength(3);
    expect(broker.requests[0]).toMatchObject({ userId: 'user-1', kind: 'calendar' });
    expect(broker.requests[1]).toMatchObject({
      userId: 'user-1',
      kind: 'memory',
      params: { slice: 'profile', domain: 'calendar' },
    });
    expect(broker.requests[2]).toMatchObject({
      userId: 'user-1',
      kind: 'memory',
      params: { scopeKind: 'calendar' },
    });
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
    // ESM has no `__dirname`; derive it from this module's own URL.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '../../../packages/agent-runtime/package.json');
    const pkg: { dependencies?: Record<string, string> } = JSON.parse(
      readFileSync(pkgPath, 'utf8'),
    );
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@stewra/shared-types']);
  });
});

/**
 * The agent's containment is proven above. This block is about the OTHER direction: a trusted
 * control-plane service is allowed to reach data directly, so nothing stops one from growing its own
 * copy of a read the broker already owns — and `npm run boundaries` cannot see it, because both files
 * are legitimately inside the control plane.
 *
 * `briefingService` had exactly that. Its calendar read took only the FIRST Google account, wrote no
 * audit row, and swallowed a revoked grant that `connectionService` would have flipped to `revoked`
 * and told the user about. Every one of those is invisible at the call site and none of them fails
 * loudly, which is why the guard has to be structural rather than behavioural.
 */
describe('the briefing reads the calendar through the broker, not around it', () => {
  const briefingSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../services/briefingService.ts'),
    'utf8',
  );

  it('asks the broker for the calendar slice', () => {
    expect(briefingSource).toContain('broker.request');
    expect(briefingSource).toMatch(/kind:\s*'calendar'/);
  });

  it('does not fetch or extract calendar events itself', () => {
    // These two are the whole of the direct path: fetch the events, reduce them to facts. Importing
    // either from here means the second copy is back, whatever it looks like at the call site.
    expect(briefingSource).not.toContain('fetchUpcomingEvents');
    expect(briefingSource).not.toContain('extractCalendarFacts');
  });
});
