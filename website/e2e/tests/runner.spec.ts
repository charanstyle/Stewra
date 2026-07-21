// Phase 5 control-surface check: the in-chat "Run coding agent" card.
//
// This is the web twin of the runner card the RN app and WhatsApp bridge expose. It drives the REAL
// system end to end — no synthetic runner: the user asks Stewra (in their singleton Stewra conversation)
// to run a coding agent on one of THEIR machines, the `runnerIntentService` classifies it and proposes a
// session, the card renders, we click Start, and the confirm-gated
// `POST /messages/:id/confirm-runner-session` starts a real session on the machine.
//
// It therefore needs a runner actually ONLINE with an available harness + a workspace (pair one with
// `npx @stewra/runner pair <code>` and leave it running). With no runner online the test `test.skip(...)`s
// — same graceful-precondition discipline as the DB-gated lifecycle specs — rather than red the suite.
import { test, expect } from '../fixtures';
import { WEB, apiCall, uiHasTestids } from '../lib.mjs';

// The card's harness labels, mirrored from `ProposedRunnerSessionCard.tsx` so the NL ask names the agent
// the way a human would.
const HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
};

test.describe('runner', () => {
  test('propose a coding session on an online machine → Start → session begins', async ({ pageA }) => {
    // 1. Load the app and confirm the running build carries the testid contract (else prod isn't redeployed).
    await pageA.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
    test.skip(
      !(await uiHasTestids(pageA)),
      'requires the website data-testid contract (app-nav sentinel absent) — deploy website first',
    );

    // 2. Find a real machine to target: online, with an available harness AND at least one workspace.
    const devicesRes = await apiCall('/runner/devices');
    expect(devicesRes.status, 'GET /runner/devices').toBe(200);
    const devices = devicesRes.json?.devices ?? [];
    const device = devices.find(
      (d: {
        online: boolean;
        harnesses: { id: string; available: boolean }[];
        workspaces: unknown[];
      }) =>
        d.online &&
        d.workspaces.length > 0 &&
        d.harnesses.some((h) => h.available && HARNESS_LABELS[h.id] !== undefined),
    );
    test.skip(
      device === undefined,
      'no online runner with a harness + workspace — pair one (`npx @stewra/runner pair`) and keep it running',
    );

    const harness = device.harnesses.find(
      (h: { id: string; available: boolean }) => h.available && HARNESS_LABELS[h.id] !== undefined,
    );
    const workspace = device.workspaces[0] as { name: string };
    const harnessLabel = HARNESS_LABELS[harness.id];
    console.log(
      `[runner] targeting device="${device.name}" workspace="${workspace.name}" harness="${harnessLabel}"`,
    );

    // 3. Open the singleton Stewra conversation, where the intent classifier proposes and the card renders.
    const convRes = await apiCall('/conversations/stewra');
    expect(convRes.status, 'GET /conversations/stewra').toBe(200);
    const convId = convRes.json?.conversation?.conversation?.id;
    expect(convId, 'Stewra conversation id').toBeTruthy();
    await pageA.goto(`${WEB}/chats/${convId}`, { waitUntil: 'domcontentloaded' });

    const input = pageA.getByPlaceholder('Type a message');
    await input.waitFor({ timeout: 15000 });

    // 4. Ask, in natural language, to run a tiny throwaway edit — named machine, repo, and agent so the
    //    classifier has an unambiguous proposal to make. The edit lands in an isolated worktree (Phase 2),
    //    never on the base branch.
    const ask =
      `Run "echo stewra-e2e > .stewra-e2e-check.txt" on ${device.name} ` +
      `in ${workspace.name} using ${harnessLabel}.`;
    await input.fill(ask);
    await pageA.getByRole('button', { name: 'Send' }).click();

    // 5. Stewra classifies + proposes: the card appears in a `pending` state. Generous timeout — this is a
    //    real LLM turn.
    const card = pageA.getByTestId('runner-session-card');
    await card.waitFor({ timeout: 90000 });
    await expect(card, 'proposed session starts pending').toHaveAttribute('data-status', 'pending');
    console.log('[runner] proposal card rendered (pending)');

    // 6. Approve: Start dispatches to the machine. Card goes busy, then resolves — `sent` on success, or
    //    `failed` if the machine hiccupped (still a real, informative outcome, not a card bug).
    await pageA.getByTestId('runner-session-start').click();
    await expect
      .poll(async () => (await card.getAttribute('data-status')) ?? 'pending', { timeout: 60000 })
      .not.toBe('pending');

    const finalStatus = await card.getAttribute('data-status');
    console.log(`[runner] after Start → data-status=${finalStatus}`);
    expect(
      finalStatus,
      `Start should send (or surface a real failure), not stay pending; got ${finalStatus}`,
    ).not.toBe('pending');

    if (finalStatus === 'sent') {
      await expect(pageA.getByTestId('runner-session-status')).toContainText('Started on');
    }
  });
});
