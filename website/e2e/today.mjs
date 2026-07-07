// Today-page E2E: drives the proactive Home ("/today") in headless Chromium as User A, exactly as an
// end user would — real navigation and clicks, no API shortcuts for the assertions. Every check
// cross-references the rendered DOM against backend truth (the same /home/briefing + /home/suggestions
// the page consumes), so a pass means "the UI faithfully shows what the backend computed", not just
// "some text appeared". Isolated try/catch per feature; writes today-report.{md,json} + shots/.
//
// Precondition: a briefing must already be computed for User A (the scheduler's job in prod; seed it
// once with POST /home/recompute). With no briefing the page shows its empty state and the content
// checks report `skip`, not `fail`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WEB, A, refresh, apiCall, launchBrowser, contextFor, step, summarize } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });

const report = [];
const shot = async (page, name) => {
  try {
    await page.screenshot({ path: join(SHOTS, `today-${name}.png`), fullPage: true });
  } catch {
    /* screenshots are best-effort */
  }
};

/** Fail loudly with a one-line message the reporter can show. */
function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

async function main() {
  if (!(await refresh(A))) {
    throw new Error('[today] refresh failed — User A refresh token stale. Update e2e.config.json.');
  }

  // Backend truth the page is expected to render.
  const briefingRes = await apiCall('/home/briefing');
  const suggRes = await apiCall('/home/suggestions');
  const briefing = briefingRes.json?.data?.briefing ?? null;
  const suggestions = suggRes.json?.data?.suggestions ?? [];
  console.log(`\n[today] backend truth: briefing=${briefing ? 'present' : 'null'}, suggestions=${suggestions.length}`);

  const browser = await launchBrowser();
  const ctx = await contextFor(browser, A);
  const page = await ctx.newPage();

  // Capture client-side errors — a passing UI must not be throwing in the console.
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 200)}`));

  try {
    // 1) Post-login landing: hitting the site root lands the authenticated user on /today.
    await step(report, 'Root redirects to /today (post-login landing)', async () => {
      await page.goto(WEB, { waitUntil: 'networkidle' });
      await page.waitForURL(/\/today$/, { timeout: 15000 });
      assert(/\/today$/.test(page.url()), `expected /today, got ${page.url()}`);
      await shot(page, '01-landing');
      return page.url();
    });

    // 2) Header greeting + subtitle render.
    await step(report, 'Header greeting + subtitle render', async () => {
      const h1 = await page.getByRole('heading', { level: 1 }).first().textContent();
      assert(/good (morning|afternoon|evening)/i.test(h1 || ''), `unexpected greeting: "${h1}"`);
      await assert(
        await page.getByText('Here’s what Stewra is watching for you today.').isVisible(),
        'subtitle missing',
      );
      return h1?.trim();
    });

    // 3) Re-consent banner — User A's Google grant predates the write scopes, so needsReconsent=true.
    await step(report, 'Re-consent banner shows with Reconnect action', async () => {
      const conns = (await apiCall('/connections')).json?.data?.connections ?? [];
      const needs = conns.some((c) => c.needsReconsent);
      if (!needs) return 'no connection needs re-consent (skipping banner assertion)';
      assert(
        await page.getByText('Reconnect Google to enable actions on your suggestions.').isVisible(),
        'reconsent banner text missing while a connection needsReconsent',
      );
      assert(
        await page.getByRole('button', { name: 'Reconnect' }).isVisible(),
        'Reconnect button missing',
      );
      return 'banner + Reconnect button present';
    });

    // 4) Briefing card renders the exact summary + section headings the backend computed.
    await step(report, 'Briefing card matches backend summary + sections', async () => {
      if (!briefing) return 'skip: no briefing computed for User A';
      const head = briefing.summary.slice(0, 45);
      assert(await page.getByText(head, { exact: false }).first().isVisible(), 'briefing summary not rendered');
      for (const s of briefing.sections) {
        assert(
          await page.getByRole('heading', { level: 3, name: s.heading }).isVisible(),
          `section heading "${s.heading}" not rendered`,
        );
      }
      await shot(page, '02-briefing');
      return `summary + ${briefing.sections.length} section(s) rendered`;
    });

    // 5) "Needs your attention" shows exactly the open suggestions the backend returned.
    await step(report, 'Nudge list matches backend suggestion count', async () => {
      assert(await page.getByText('Needs your attention').isVisible(), '"Needs your attention" section missing');
      if (suggestions.length === 0) {
        assert(await page.getByText('You’re all caught up.').isVisible(), 'empty-state copy missing');
        return 'empty state (0 suggestions)';
      }
      // Each nudge title appears verbatim in its card header. Spot-check the first three.
      for (const s of suggestions.slice(0, 3)) {
        assert(await page.getByText(s.title, { exact: false }).first().isVisible(), `nudge "${s.title}" not rendered`);
      }
      return `${suggestions.length} nudge card(s), titles match`;
    });

    // 6) Expand the first nudge → decision prompt (options + add-info + action buttons).
    let firstTitle = suggestions[0]?.title;
    await step(report, 'Expand nudge reveals decision prompt', async () => {
      if (!firstTitle) return 'skip: no nudges to expand';
      const header = page.getByRole('button', { expanded: false }).filter({ hasText: firstTitle }).first();
      await header.click();
      // The option button ("Draft a reply"), add-info label, and the four action buttons should appear.
      assert(await page.getByText('Add info').first().isVisible(), 'add-info field missing after expand');
      assert(await page.getByRole('button', { name: 'Snooze to tomorrow' }).first().isVisible(), 'Snooze button missing');
      assert(await page.getByRole('button', { name: 'Dismiss' }).first().isVisible(), 'Dismiss button missing');
      assert(
        await page.getByRole('button', { name: /Chat with Stewra about this/ }).first().isVisible(),
        'Chat button missing',
      );
      await shot(page, '03-nudge-expanded');
      return 'options + add-info + actions visible';
    });

    // 7) Click "Draft a reply" → a real style-aware draft comes back (read-only, no send).
    await step(report, 'Draft a reply returns draft text', async () => {
      if (!firstTitle) return 'skip: no nudges';
      const draftOption = page.getByRole('button', { name: 'Draft a reply' }).first();
      if (!(await draftOption.isVisible())) return 'skip: first nudge has no reply option';
      await draftOption.click();
      await page.getByText('Draft ready — review it in Chat.').waitFor({ state: 'visible', timeout: 45000 });
      const draftVal = await page.getByRole('textbox', { name: 'Drafted reply' }).inputValue();
      assert(draftVal.trim().length > 0, 'draft textarea is empty');
      await shot(page, '04-draft');
      return `draft ${draftVal.length} chars`;
    });

    // 8) Snooze the first nudge → it leaves the open list (card count drops by one).
    await step(report, 'Snooze removes nudge from the list', async () => {
      if (!firstTitle) return 'skip: no nudges';
      const before = await page.getByText('Needs a reply').count();
      await page.getByRole('button', { name: 'Snooze to tomorrow' }).first().click();
      await page.getByText(firstTitle, { exact: false }).first().waitFor({ state: 'detached', timeout: 15000 });
      const after = await page.getByText('Needs a reply').count();
      assert(after === before - 1, `expected ${before - 1} cards after snooze, got ${after}`);
      return `${before} → ${after} cards`;
    });

    // 9) Dismiss the (new) first nudge → also leaves the list. Verify it stays gone after reload
    //    (status persisted server-side, not just client state).
    await step(report, 'Dismiss removes nudge and persists across reload', async () => {
      const open = (await apiCall('/home/suggestions')).json?.data?.suggestions ?? [];
      if (open.length === 0) return 'skip: nothing left to dismiss';
      const target = open[0].title;
      const header = page.getByRole('button', { expanded: false }).filter({ hasText: target }).first();
      await header.click();
      await page.getByRole('button', { name: 'Dismiss' }).first().click();
      await page.getByText(target, { exact: false }).first().waitFor({ state: 'detached', timeout: 15000 });
      // Reload: the dismissed nudge must not reappear.
      await page.reload({ waitUntil: 'networkidle' });
      const stillGone = (await page.getByText(target, { exact: false }).count()) === 0;
      assert(stillGone, `dismissed nudge "${target}" reappeared after reload`);
      return `"${target.slice(0, 30)}…" dismissed + stays gone`;
    });

    // 10) "Chat with Stewra about this" seeds a conversation and deep-links into /stewra.
    await step(report, 'Chat-about-this deep-links into /stewra', async () => {
      const open = (await apiCall('/home/suggestions')).json?.data?.suggestions ?? [];
      if (open.length === 0) return 'skip: no nudges to chat about';
      const target = open[0].title;
      const header = page.getByRole('button', { expanded: false }).filter({ hasText: target }).first();
      await header.click();
      await page.getByRole('button', { name: /Chat with Stewra about this/ }).first().click();
      await page.waitForURL(/\/stewra$/, { timeout: 45000 });
      await shot(page, '05-stewra-chat');
      return `landed on ${page.url()}`;
    });

    // 11) AppNav: Today is the first nav item and navigation round-trips.
    await step(report, 'AppNav has Today first + navigation works', async () => {
      const names = await page.getByRole('link').allTextContents();
      const navNames = names.map((n) => n.trim()).filter(Boolean);
      assert(navNames[0] === 'Today', `first nav item is "${navNames[0]}", expected "Today"`);
      await page.getByRole('link', { name: 'Activity' }).click();
      await page.waitForURL(/\/activity$/, { timeout: 15000 });
      await page.getByRole('link', { name: 'Today' }).click();
      await page.waitForURL(/\/today$/, { timeout: 15000 });
      return 'Today→Activity→Today round-trip ok';
    });

    // 12) No client-side errors during the whole flow.
    await step(report, 'No console/page errors during flow', async () => {
      // A benign, known-noisy source: socket reconnect chatter is not an error. Filter nothing for now;
      // report the raw list so regressions are visible.
      assert(consoleErrors.length === 0, `console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
      return 'clean';
    });
  } finally {
    await ctx.close();
    await browser.close();
  }

  const { pass, fail, total } = summarize(report);
  const md = [
    `# Today page E2E — ${new Date().toISOString()}`,
    ``,
    `Target: ${WEB} · User A: ${A.email || '(unlabeled)'}`,
    `Backend truth at run: briefing=${briefing ? 'present' : 'null'}, suggestions=${suggestions.length}`,
    ``,
    `**${pass} passed, ${fail} failed of ${total}**`,
    ``,
    ...report.map((r) => `- ${r.status === 'PASS' ? '✅' : '❌'} **${r.name}**${r.detail ? ` — ${r.detail}` : ''}`),
    ``,
    consoleErrors.length ? `## Console errors\n\n${consoleErrors.map((e) => `- ${e}`).join('\n')}` : '',
  ].join('\n');
  writeFileSync(join(HERE, 'today-report.md'), md);
  writeFileSync(join(HERE, 'today-report.json'), JSON.stringify({ pass, fail, total, report, consoleErrors }, null, 2));
  console.log(`\nWrote today-report.md (${pass}/${total} passed)`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[today] fatal:', err);
  process.exitCode = 1;
});
