#!/usr/bin/env node
// Build an organization's structure the way a business account builds it: through the screens.
//
// This is the dogfooding driver for the first real business account (Nurturing Lab Limited) — one
// org, five projects, the machines that host them — and it touches nothing but the web UI. No REST
// shortcuts, no SQL, no seeding: if a step cannot be done from a screen, this script cannot do it
// either, and that is the point. Every subcommand is idempotent, so the whole thing can be re-run
// after a partial failure and only does what is still missing.
//
//   node structure.mjs org                        create + select the org, make it the texting org
//   node structure.mjs pair                       mint a pairing code for the org (prints CODE=…)
//   node structure.mjs wait-device <name>         wait until a machine with that name shows online
//   node structure.mjs env <name> <environment>   label a machine development | production
//   node structure.mjs move <name>                move a machine from another org into this one
//   node structure.mjs rescan <name>              ask a machine to re-announce its checkouts
//   node structure.mjs projects                   create every project that does not exist yet
//   node structure.mjs bind                       bind each project to its checkout on each machine
//   node structure.mjs status                     print the projects × machines matrix
//
// Credentials: E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD in the repo-root .env.e2e (gitignored), the
// account that owns the org. Signs in through /login like a person.
import { chromium } from 'playwright';
import { env, required } from './env.mjs';

const WEB = required(env.E2E_WEB_URL, 'E2E_WEB_URL').replace(/\/$/, '');
const OWNER_EMAIL = required(env.E2E_OWNER_EMAIL, 'E2E_OWNER_EMAIL');
const OWNER_PASSWORD = required(env.E2E_OWNER_PASSWORD, 'E2E_OWNER_PASSWORD');

export const ORG_NAME = 'Nurturing Lab Limited';
/** Where every machine keeps its checkouts; the runner is started with this as its workspace root. */
export const WORKSPACE_ROOT = '/Volumes/charan/projects';

/** The five projects. `repo` is what the checkout directory is called — it is not the project name. */
export const PROJECTS = [
  { name: 'Stewra', repo: 'Stewra', ghRepo: 'Stewra', aliases: 'stewra app' },
  { name: 'Truetalk', repo: 'product_advisor', ghRepo: 'product_advisor', aliases: 'true talk, product advisor' },
  { name: 'LookedTwice', repo: 'rank', ghRepo: 'rank', aliases: 'RankRise, rank rise, looked twice' },
  { name: 'MyMoneyWorthy', repo: 'mymoneyworthy', ghRepo: 'mymoneyworthy', aliases: 'my money worthy' },
  { name: 'NurturingLab v2', repo: 'nurturinglabv2', ghRepo: 'nurturinglabv2', aliases: 'nurturing lab, nurturinglab' },
];
const GITHUB_OWNER = 'charanstyle';
const DEFAULT_BRANCH = 'master';

const TIMEOUT = 20_000;

function log(message) {
  console.log(`[structure] ${message}`);
}

/** Sign in through the form. Fails loudly if the app does not let the owner in. */
async function signIn(page) {
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByLabel('Password').fill(OWNER_PASSWORD);
  // The mode tab and the submit button share the accessible name; the submit is the last one.
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await page.waitForURL(/\/(today|chats)/, { timeout: 30_000 });
  log(`signed in as ${OWNER_EMAIL}`);
}

/** The option label the org list renders for the org we own. */
const ORG_OPTION = `${ORG_NAME} · business · owner`;

async function orgOptionValue(select) {
  const options = select.locator('option');
  const n = await options.count();
  for (let i = 0; i < n; i += 1) {
    const text = (await options.nth(i).textContent()) ?? '';
    if (text.trim() === ORG_OPTION) {
      return (await options.nth(i).getAttribute('value')) ?? '';
    }
  }
  return null;
}

/** /commerce: the org exists, is selected, and is the one texting Stewra acts on. */
async function ensureOrg(page) {
  await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
  const select = page.getByRole('combobox').first();
  await page.getByPlaceholder('New organization name').waitFor({ timeout: TIMEOUT });

  let orgId = (await select.count()) > 0 ? await orgOptionValue(select) : null;
  if (orgId === null) {
    await page.getByPlaceholder('New organization name').fill(ORG_NAME);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText(`Created ${ORG_NAME}. You are its owner.`).waitFor({ timeout: TIMEOUT });
    orgId = await orgOptionValue(page.getByRole('combobox').first());
    if (orgId === null) {
      throw new Error(`created ${ORG_NAME} but it is not listed as "${ORG_OPTION}"`);
    }
    log(`created ${ORG_NAME} (${orgId})`);
  } else {
    log(`${ORG_NAME} already exists (${orgId})`);
  }

  await page.getByRole('combobox').first().selectOption(orgId);
  const useIt = page.getByRole('button', { name: 'Use this one when I text Stewra' });
  if ((await useIt.count()) > 0) {
    await useIt.click();
    await page.getByText('Texting Stewra now acts on this organization.').waitFor({ timeout: TIMEOUT });
    log(`${ORG_NAME} is now the org texting Stewra acts on`);
  } else {
    await page.getByText('Texting Stewra acts on this one').waitFor({ timeout: TIMEOUT });
    log(`${ORG_NAME} was already the org texting Stewra acts on`);
  }
  return orgId;
}

/** /fleet with our org selected. Returns the org id the page is showing. */
async function openFleet(page) {
  await page.goto(`${WEB}/fleet`, { waitUntil: 'domcontentloaded' });
  const select = page.getByTestId('fleet-org-select');
  await select.waitFor({ timeout: TIMEOUT });
  const orgId = await orgOptionValue(select);
  if (orgId === null) {
    throw new Error(`${ORG_NAME} is not in the fleet org selector — run "org" first`);
  }
  if ((await select.inputValue()) !== orgId) {
    await select.selectOption(orgId);
  }
  await page.getByTestId('fleet-matrix').or(page.getByTestId('fleet-pair')).first().waitFor({ timeout: TIMEOUT });
  return orgId;
}

async function mintPairingCode(page) {
  await openFleet(page);
  await page.getByTestId('fleet-pair').click();
  const block = page.getByTestId('fleet-pair-code');
  await block.waitFor({ timeout: TIMEOUT });
  // textContent() joins the <code> element and the "No runner yet?" paragraph that follows it with
  // no separator, so a greedy \S+ would capture "STEWRA-XXXXXXXXNo". Match the exact format the
  // backend mints (runnerDeviceRepository: STEWRA- + 8 chars from its ambiguity-free alphabet).
  const text = (await block.textContent()) ?? '';
  const match = /stewra-runner pair\s+(STEWRA-[ACDEFGHJKLMNPQRTUVWXYZ2346789]{8})/.exec(text);
  if (match === null) {
    throw new Error(`pairing block does not show a command: ${text.slice(0, 200)}`);
  }
  log(`pairing code minted for ${ORG_NAME}`);
  console.log(`CODE=${match[1]}`);
}

function deviceRow(page, name) {
  return page.locator('[data-testid="fleet-device-row"]', { hasText: name }).first();
}

async function waitForDevice(page, name) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    await openFleet(page);
    const row = deviceRow(page, name);
    if ((await row.count()) > 0) {
      // innerText keeps the rendered separators; textContent would glue "online" to the next
      // control's label ("onlinedevelopment") and defeat the word-boundary test below.
      const text = (await row.innerText()).replace(/\s+/g, ' ').trim();
      if (/\bonline\b/i.test(text) && !/\boffline\b/i.test(text)) {
        log(`${name} is online: ${text}`);
        return;
      }
      log(`${name} is listed but not online yet: ${text}`);
    } else {
      log(`${name} is not listed yet`);
    }
    if (Date.now() > deadline) {
      throw new Error(`${name} did not come online within 120s`);
    }
    await page.waitForTimeout(5000);
  }
}

async function setEnvironment(page, name, environment) {
  if (environment !== 'development' && environment !== 'production') {
    throw new Error(`environment must be development or production, got "${environment}"`);
  }
  await openFleet(page);
  const row = deviceRow(page, name);
  await row.waitFor({ timeout: TIMEOUT });
  const select = row.getByTestId('fleet-device-environment');
  if ((await select.inputValue()) === environment) {
    log(`${name} is already a ${environment} machine`);
    return;
  }
  await select.selectOption(environment);
  await page.getByText(`${name} is now a ${environment} machine.`).waitFor({ timeout: TIMEOUT });
  log(`${name} is now a ${environment} machine`);
}

/** Move a machine listed under ANOTHER org we administer into this one. */
async function moveDevice(page, name) {
  await page.goto(`${WEB}/fleet`, { waitUntil: 'domcontentloaded' });
  const orgSelect = page.getByTestId('fleet-org-select');
  await orgSelect.waitFor({ timeout: TIMEOUT });
  const target = await orgOptionValue(orgSelect);
  if (target === null) {
    throw new Error(`${ORG_NAME} is not in the fleet org selector — run "org" first`);
  }
  const options = orgSelect.locator('option');
  const n = await options.count();
  for (let i = 0; i < n; i += 1) {
    const value = (await options.nth(i).getAttribute('value')) ?? '';
    if (value === '' || value === target) continue;
    await orgSelect.selectOption(value);
    await page.waitForTimeout(1500);
    const row = deviceRow(page, name);
    if ((await row.count()) === 0) continue;
    // Two comboboxes in a row: environment first, then "Move to…".
    const moveSelect = row.getByRole('combobox').nth(1);
    if ((await moveSelect.count()) === 0) {
      throw new Error(`${name} is in another org but the row offers no "Move to…" — not an admin there?`);
    }
    await moveSelect.selectOption(target);
    await row.getByRole('button', { name: 'Move', exact: true }).click();
    await page.getByText(`${name} moved to ${ORG_NAME}.`).waitFor({ timeout: TIMEOUT });
    log(`${name} moved to ${ORG_NAME}`);
    return;
  }
  throw new Error(`${name} is not listed under any other org this account administers`);
}

async function rescan(page, name) {
  await openFleet(page);
  const row = deviceRow(page, name);
  await row.waitFor({ timeout: TIMEOUT });
  const button = row.getByTestId('fleet-device-rescan');
  if (await button.isDisabled()) {
    throw new Error(`${name} cannot be rescanned right now (offline?)`);
  }
  await button.click();
  log(`asked ${name} to rescan`);
  await page.waitForTimeout(4000);
}

function projectRow(page, name) {
  return page.locator(`[data-testid="fleet-project-row"][data-project-name="${name}"]`);
}

async function ensureProjects(page) {
  await openFleet(page);
  for (const p of PROJECTS) {
    if ((await projectRow(page, p.name).count()) > 0) {
      log(`project ${p.name} already exists`);
      continue;
    }
    await page.getByTestId('fleet-project-create').click();
    await page.getByTestId('fleet-project-form').waitFor({ timeout: TIMEOUT });
    await page.getByTestId('fleet-project-name').fill(p.name);
    await page.getByTestId('fleet-project-repo').fill(p.repo);
    await page.getByLabel('GitHub owner').fill(GITHUB_OWNER);
    await page.getByLabel('GitHub repository').fill(p.ghRepo);
    await page.getByLabel('Default branch').fill(DEFAULT_BRANCH);
    await page.getByLabel('Git remote (optional — leave empty if unsure)').fill(`https://github.com/${GITHUB_OWNER}/${p.ghRepo}.git`);
    await page.getByTestId('fleet-project-aliases').fill(p.aliases);
    await page.getByTestId('fleet-project-save').click();
    await projectRow(page, p.name).waitFor({ timeout: TIMEOUT });
    log(`created project ${p.name} (${p.repo})`);
  }
}

/** Machine names in matrix column order — the header row after the first (project) column. */
async function deviceColumns(page) {
  const headers = page.getByTestId('fleet-matrix').locator('thead th');
  const n = await headers.count();
  const names = [];
  for (let i = 1; i < n; i += 1) {
    names.push(((await headers.nth(i).textContent()) ?? '').replace(/\s+/g, ' ').trim());
  }
  return names;
}

async function bindAll(page) {
  await openFleet(page);
  const devices = await deviceColumns(page);
  if (devices.length === 0) {
    throw new Error('no machines in the matrix — pair one first');
  }
  for (const p of PROJECTS) {
    const row = projectRow(page, p.name);
    if ((await row.count()) === 0) {
      throw new Error(`project ${p.name} does not exist — run "projects" first`);
    }
    for (let i = 0; i < devices.length; i += 1) {
      const cell = row.getByTestId('fleet-cell').nth(i);
      const state = await cell.getAttribute('data-state');
      if (state !== 'unbound') {
        log(`${p.name} × ${devices[i]}: ${state}`);
        continue;
      }
      await cell.getByTestId('fleet-bind').click();
      const dialog = page.getByTestId('fleet-bind-dialog');
      await dialog.waitFor({ timeout: TIMEOUT });
      const workspaceSelect = page.getByTestId('fleet-bind-workspace');
      let chosen = null;
      if ((await workspaceSelect.count()) > 0) {
        const options = workspaceSelect.locator('option');
        const n = await options.count();
        const wanted = `${WORKSPACE_ROOT}/${p.repo}`;
        for (let j = 0; j < n; j += 1) {
          const text = ((await options.nth(j).textContent()) ?? '').trim();
          if (text.endsWith(` — ${wanted}`)) {
            chosen = (await options.nth(j).getAttribute('value')) ?? null;
            break;
          }
        }
      }
      if (chosen === null) {
        log(`${p.name} × ${devices[i]}: ${devices[i]} does not report ${WORKSPACE_ROOT}/${p.repo} — left unbound`);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        continue;
      }
      await workspaceSelect.selectOption(chosen);
      await page.getByTestId('fleet-bind-save').click();
      await dialog.waitFor({ state: 'detached', timeout: TIMEOUT });
      const after = await cell.getAttribute('data-state');
      log(`${p.name} × ${devices[i]}: bound → ${after}`);
    }
  }
}

async function status(page) {
  await openFleet(page);
  const devices = await deviceColumns(page);
  console.log(['project', ...devices].join(' | '));
  for (const p of PROJECTS) {
    const row = projectRow(page, p.name);
    if ((await row.count()) === 0) {
      console.log(`${p.name} | (missing)`);
      continue;
    }
    const states = [];
    for (let i = 0; i < devices.length; i += 1) {
      states.push((await row.getByTestId('fleet-cell').nth(i).getAttribute('data-state')) ?? '?');
    }
    console.log([p.name, ...states].join(' | '));
  }
}

async function main(argv) {
  const [command, ...args] = argv;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await signIn(page);
    switch (command) {
      case 'org':
        await ensureOrg(page);
        return;
      case 'pair':
        await mintPairingCode(page);
        return;
      case 'wait-device':
        await waitForDevice(page, required(args[0], 'device name'));
        return;
      case 'env':
        await setEnvironment(page, required(args[0], 'device name'), required(args[1], 'environment'));
        return;
      case 'move':
        await moveDevice(page, required(args[0], 'device name'));
        return;
      case 'rescan':
        await rescan(page, required(args[0], 'device name'));
        return;
      case 'projects':
        await ensureProjects(page);
        return;
      case 'bind':
        await bindAll(page);
        return;
      case 'status':
        await status(page);
        return;
      default:
        throw new Error('usage: structure.mjs <org|pair|wait-device|env|move|rescan|projects|bind|status> …');
    }
  } catch (error) {
    await page.screenshot({ path: `.artifacts/structure-${command ?? 'usage'}-failed.png`, fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`[structure] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
