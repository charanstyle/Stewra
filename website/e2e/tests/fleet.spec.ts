// The fleet page: an organization's projects × machines, driven the way a business account drives it —
// through the screen. Project creation and editing need no machine and always run. The binding and
// cell-state checks need a runner ONLINE with at least one reported checkout; without one they skip,
// unless E2E_REQUIRE_RUNNER=1 turns that leniency off (same discipline as runner.spec.ts).
import { test, expect } from '../fixtures';
import { WEB, apiCall, uiHasTestids } from '../lib.mjs';
import { env } from '../env.mjs';

const requireRunner = env.E2E_REQUIRE_RUNNER === '1';

function skipUnlessRequired(unmet: boolean, reason: string): void {
  if (unmet && requireRunner) {
    throw new Error(`E2E_REQUIRE_RUNNER=1 but ${reason}`);
  }
  test.skip(unmet, reason);
}

const CELL_STATES = ['ready', 'stale', 'offline', 'unbound'];

/** The org the page is showing — read from its selector so the spec cleans up in the same tenant. */
async function selectedOrgId(page: import('@playwright/test').Page): Promise<string> {
  const value = await page.getByTestId('fleet-org-select').inputValue();
  expect(value, 'fleet org selector has a value').not.toBe('');
  return value;
}

async function archiveByName(orgId: string, name: string): Promise<void> {
  const list = await apiCall(`/orgs/${orgId}/projects`);
  const project = (list.json?.data?.projects ?? []).find((p: { name: string }) => p.name === name);
  if (project !== undefined) {
    await apiCall(`/orgs/${orgId}/projects/${project.id}/archive`, { method: 'POST', body: {} });
  }
}

test.describe('fleet', () => {
  test('create a project, see it in the matrix unbound everywhere, edit its aliases', async ({ pageA }) => {
    await pageA.goto(`${WEB}/fleet`, { waitUntil: 'domcontentloaded' });
    test.skip(
      !(await uiHasTestids(pageA)),
      'requires the website data-testid contract (app-nav sentinel absent) — deploy website first',
    );
    await pageA.getByTestId('fleet-org-select').waitFor({ timeout: 15000 });
    const orgId = await selectedOrgId(pageA);

    const name = `E2E Project ${Date.now().toString(36)}`;
    try {
      // Create — the user types the name; nothing is derived from a repo picker.
      await pageA.getByTestId('fleet-project-create').click();
      await pageA.getByTestId('fleet-project-name').fill(name);
      await pageA.getByTestId('fleet-project-repo').fill('e2e_repo');
      await pageA.getByTestId('fleet-project-aliases').fill('first alias');
      await pageA.getByTestId('fleet-project-save').click();

      const row = pageA.locator('[data-testid="fleet-project-row"]', { has: pageA.locator(`[data-project-name="${name}"]`) })
        .or(pageA.locator(`[data-testid="fleet-project-row"][data-project-name="${name}"]`));
      await expect(row.first(), 'the new project appears as a matrix row').toBeVisible({ timeout: 15000 });
      await expect(row.first().getByText('e2e_repo'), 'repo name shown beside the project name').toBeVisible();
      await expect(row.first().getByText('first alias')).toBeVisible();

      // Every cell on the new row is a real state, and — never having been bound — `unbound`.
      const cells = row.first().getByTestId('fleet-cell');
      const cellCount = await cells.count();
      const devices = await apiCall(`/orgs/${orgId}/runner/devices`);
      expect(cellCount, 'one cell per machine in the org').toBe((devices.json?.data?.devices ?? []).length);
      for (let i = 0; i < cellCount; i += 1) {
        const state = await cells.nth(i).getAttribute('data-state');
        expect(CELL_STATES, `cell ${i} has a known state`).toContain(state);
        expect(state, `cell ${i} of a fresh project is unbound`).toBe('unbound');
      }

      // Edit — aliases are what the chat and voice layers match on, so they must round-trip.
      await row.first().getByRole('button', { name: 'Edit' }).click();
      await pageA.getByTestId('fleet-project-aliases').fill('first alias, second alias');
      await pageA.getByTestId('fleet-project-save').click();
      await expect(row.first().getByText('second alias')).toBeVisible({ timeout: 15000 });
    } finally {
      await archiveByName(orgId, name);
    }
  });

  test('bind a project to a checkout an online machine reports → cell becomes ready → unbind', async ({ pageA }) => {
    await pageA.goto(`${WEB}/fleet`, { waitUntil: 'domcontentloaded' });
    skipUnlessRequired(
      !(await uiHasTestids(pageA)),
      'requires the website data-testid contract (app-nav sentinel absent) — deploy website first',
    );
    await pageA.getByTestId('fleet-org-select').waitFor({ timeout: 15000 });
    const orgId = await selectedOrgId(pageA);

    const devices = await apiCall(`/orgs/${orgId}/runner/devices`);
    const online = (devices.json?.data?.devices ?? []).find(
      (d: { online: boolean; workspaces: unknown[] }) => d.online && d.workspaces.length > 0,
    );
    skipUnlessRequired(online === undefined, 'no online runner reporting a checkout in this org — pair one and keep it running');

    // The checkouts already bound on that machine cannot be bound again; the dialog only offers free ones.
    const bound = await apiCall(`/orgs/${orgId}/projects/bindings`);
    const taken = new Set((bound.json?.data?.bindings ?? []).filter((b: { deviceId: string }) => b.deviceId === online.id).map((b: { workspaceId: string }) => b.workspaceId));
    const free = online.workspaces.find((w: { id: string }) => !taken.has(w.id));
    skipUnlessRequired(free === undefined, `${online.name} has no unbound checkout left to bind`);

    const name = `E2E Bind ${Date.now().toString(36)}`;
    try {
      await pageA.getByTestId('fleet-project-create').click();
      await pageA.getByTestId('fleet-project-name').fill(name);
      await pageA.getByTestId('fleet-project-repo').fill(free.name);
      await pageA.getByTestId('fleet-project-save').click();
      const row = pageA.locator(`[data-testid="fleet-project-row"][data-project-name="${name}"]`);
      await expect(row).toBeVisible({ timeout: 15000 });

      // The matrix column order is the device list order, so find the cell by index.
      const index = (devices.json?.data?.devices ?? []).findIndex((d: { id: string }) => d.id === online.id);
      const cell = row.getByTestId('fleet-cell').nth(index);
      await expect(cell).toHaveAttribute('data-state', 'unbound');

      await cell.getByTestId('fleet-bind').click();
      await pageA.getByTestId('fleet-bind-workspace').selectOption(free.id);
      await pageA.getByTestId('fleet-bind-save').click();

      // Bound, online, and the checkout is in the machine's live hello: ready, with a Run here button.
      await expect(cell).toHaveAttribute('data-state', 'ready', { timeout: 15000 });
      await expect(cell.getByTestId('fleet-run-here')).toBeVisible();

      await cell.getByRole('button', { name: 'Unbind' }).click();
      await expect(cell).toHaveAttribute('data-state', 'unbound', { timeout: 15000 });
    } finally {
      await archiveByName(orgId, name);
    }
  });
});
