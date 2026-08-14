// The campaign plane, driven through the real website: a template submitted and mirrored, a
// broadcast scheduled against a segment and carried to completion by the real job worker, the cost
// report's honest counts — and the inbox's single-conversation template send.
//
// Same footing as `commerce.spec.ts`: browser, page, API, backend, Postgres, the vault, the
// webhook signature gate and the in-process `commerce_jobs` worker are all real. Meta is the
// stand-in (`graphStub.mjs`), which for this file also means: template approval is the stub's
// answer at submission time (Meta really does approve some templates instantly), and no delivery
// receipts ever arrive — a fact the costs assertion leans on rather than papers over.
//
// The billable half needs the platform operator's grants (a rate card and spend headroom) — those
// go through the real `/platform/*` routes, because the alternative is every send being refused as
// unpriceable spend. See `grantPricingAndHeadroom`.
import { randomUUID } from 'node:crypto';
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  WEB,
  connectChannel,
  createOrg,
  deliverInbound,
  grantPricingAndHeadroom,
  graphCalls,
  openOrgPage,
  setGraphState,
  tokens,
} from './support';

/**
 * The current minute as a `datetime-local` value — deliberately NOT the page's default, which is a
 * minute in the future. `scheduledFor` becomes the dispatch job's `runAfter`, so the current minute
 * (already a few seconds in the past) is what makes "schedule now" mean now instead of a fixed
 * sixty-second stall in every run.
 */
function currentMinuteLocal(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`;
}

async function outboundSendCount(): Promise<number> {
  return (await graphCalls()).filter((c) => c.pathname.endsWith('/messages')).length;
}

/** The `<section>` card under the given heading — the page repeats input shapes across cards. */
function card(page: Page, heading: string): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
}

/**
 * Completes the sending policy on the audience page: quiet hours saved, attestation signed.
 *
 * Equal start and end is the policy's own way of saying "no quiet hours" — the one deterministic
 * choice, because any real window would make this suite pass or fail by the wall clock of the
 * machine running it.
 */
async function completeSendingPolicy(page: Page): Promise<void> {
  await page.getByPlaceholder('IANA timezone, e.g. Europe/London').fill('Europe/London');
  await page.getByPlaceholder('Quiet from (HH:MM)').fill('09:00');
  await page.getByPlaceholder('until (HH:MM)').fill('09:00');
  await page.getByRole('button', { name: 'Save quiet hours' }).click();
  await expect(page.getByText('Quiet hours saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Sign as owner' }).click();
  await expect(page.getByText(/Attestation signed/)).toBeVisible();
}

/** Submits a template through the campaigns page and waits for its approved mirror row. */
async function submitApprovedTemplate(
  page: Page,
  params: { name: string; body: string; category: 'marketing' | 'utility' },
): Promise<void> {
  const templatesCard = card(page, 'Templates');
  await templatesCard.getByPlaceholder('name_like_this').fill(params.name);
  await templatesCard
    .locator('select')
    .selectOption(params.category);
  await templatesCard
    .getByPlaceholder('Body — placeholders like {{1}} become per-campaign values')
    .fill(params.body);
  await templatesCard.getByRole('button', { name: 'Submit to Meta' }).click();
  // The status in the notice is Meta's answer relayed, not this page's optimism — the stub answers
  // APPROVED at submission, so the mirror row is sendable immediately.
  await expect(
    page.getByText(new RegExp(`Submitted "${params.name}" to Meta\\. It is approved`)),
  ).toBeVisible();
}

test.describe('campaigns', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    const auth = await tokens();
    context = await browser.newContext({
      storageState: {
        cookies: [],
        origins: [
          { origin: WEB, localStorage: [{ name: 'stewra.tokens', value: JSON.stringify(auth) }] },
        ],
      },
    });
    page = await context.newPage();
  });

  test.afterEach(async () => {
    await context.close();
  });

  test('a broadcast reaches its segment: scheduled in the UI, completed by the worker, costed honestly', async () => {
    const wabaId = `waba-broadcast-${Date.now()}`;
    await setGraphState({ wabaId, phoneStatus: 'CONNECTED' });

    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Broadcast ${Date.now()}`);
    await connectChannel(orgId, 'e2e-code-broadcast');
    await grantPricingAndHeadroom(orgId);

    // The audience half, all through its page: policy and attestation (a marketing broadcast is
    // refused without both), one opted-in contact, and a segment naming everyone with their tag.
    await openOrgPage(
      page,
      '/commerce/audience',
      orgId,
      page.getByRole('heading', { name: 'Sending policy', exact: true }),
    );
    await completeSendingPolicy(page);

    const phone = `+1555${String(Date.now()).slice(-6)}1`;
    await page.getByPlaceholder('+44 7700 900123').fill(phone);
    await page.getByPlaceholder('Name (optional)').fill('Vip Customer');
    await page.getByPlaceholder('Tags, comma separated').fill('vip');
    await page.getByText('This person has given marketing opt-in').click();
    await page
      .getByPlaceholder('Where it came from — a form URL, ad id, or list name')
      .fill('signup form at acme.example/offers');
    await page.getByRole('button', { name: 'Add contact' }).click();
    await expect(page.getByText(`${phone} added with marketing opt-in recorded.`)).toBeVisible();

    const segmentName = `VIP list ${randomUUID().slice(0, 6)}`;
    const segmentsCard = card(page, 'Segments');
    await segmentsCard.getByPlaceholder('Segment name').fill(segmentName);
    await segmentsCard.locator('select').filter({ hasText: 'Everyone tagged…' }).selectOption('vip');
    await segmentsCard.getByRole('button', { name: 'Save segment' }).click();
    await expect(page.getByText(/Segment saved\. Preview it/)).toBeVisible();

    // The campaign half.
    await openOrgPage(
      page,
      '/commerce/campaigns',
      orgId,
      page.getByRole('heading', { name: 'Templates', exact: true }),
    );
    const templateName = `sale_${Date.now()}`;
    await submitApprovedTemplate(page, {
      name: templateName,
      body: 'Hello {{1}}, our sale is on.',
      category: 'marketing',
    });

    const broadcastsCard = card(page, 'Broadcasts');
    const campaignName = `Spring push ${randomUUID().slice(0, 6)}`;
    await broadcastsCard.getByPlaceholder('Campaign name').fill(campaignName);
    await broadcastsCard
      .locator('select')
      .filter({ hasText: 'To segment…' })
      .selectOption({ label: segmentName });
    await broadcastsCard
      .locator('select')
      .filter({ hasText: 'Using template…' })
      .selectOption({ label: `${templateName} (en_US)` });
    await broadcastsCard.getByPlaceholder('Value for {{1}}').fill('Maya');

    // The forecast before the money: one selected, one billable, and the category Meta will bill
    // it as. This is the number the send below has to live up to.
    await broadcastsCard.getByRole('button', { name: 'Preview reach' }).click();
    await expect(
      page.getByText(/1 selected, 1 will be billed as marketing messages/),
    ).toBeVisible();

    const sendsBefore = await outboundSendCount();
    await broadcastsCard.locator('input[type="datetime-local"]').fill(currentMinuteLocal());
    await broadcastsCard.getByRole('button', { name: 'Schedule' }).click();
    await expect(page.getByText(new RegExp(`Scheduled "${campaignName}" for`))).toBeVisible();

    // From here the real worker carries it: dispatch materializes the audience, send walks it.
    // Progress is observed the way an operator would — reloading until the row says so.
    await expect(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(
        card(page, 'Broadcasts').getByText('completed', { exact: true }),
      ).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(card(page, 'Broadcasts').getByText(/1\/1 sent/)).toBeVisible();

    // The per-recipient ledger: the person, by name, marked sent.
    await card(page, 'Broadcasts').getByRole('button', { name: 'Recipients' }).click();
    await expect(page.getByText(/Vip Customer — sent/)).toBeVisible();

    // It really left the building — Meta's send endpoint was called over a real socket.
    expect(
      (await outboundSendCount()) - sendsBefore,
      'the broadcast send must reach Meta, not just the database',
    ).toBeGreaterThan(0);

    // The costs card tells the truth about billing state: the stub never sends delivery receipts,
    // and Meta's receipt is the only thing that prices a message — so the honest report is one SENT
    // message awaiting pricing, and zero invented into the billable columns.
    const costsCard = card(page, 'Message costs');
    await costsCard.getByRole('button', { name: 'Show what Meta charged' }).click();
    await expect(costsCard.getByText('marketing: 0 billable message(s)')).toBeVisible();
    await expect(
      costsCard.getByText(/1 sent message\(s\) with no pricing reported yet/),
    ).toBeVisible();
  });

  test('an approved template goes into a single conversation from the inbox', async () => {
    // WHY AN OPEN-WINDOW CONVERSATION: the closed-window state — the one this composer exists for —
    // cannot be reached through public surfaces. A window closes when the last inbound message is
    // 24 hours old; the webhook stamps inbound timestamps server-side, specs have no database
    // access to age one, and no API ages a conversation. The UI offers the same template composer
    // inside an open window (a template is never LESS deliverable there, and the server applies no
    // window check to template sends), so that is the path covered; the closed-window copy
    // ("Only an approved template message can reach this customer now") remains unexercised here.
    const wabaId = `waba-inbox-tpl-${Date.now()}`;
    await setGraphState({ wabaId, phoneStatus: 'CONNECTED' });

    await page.goto(`${WEB}/commerce`, { waitUntil: 'domcontentloaded' });
    const orgId = await createOrg(page, `Acme Inbox Template ${Date.now()}`);
    await connectChannel(orgId, 'e2e-code-inbox-tpl');
    // Template sends through the inbox face the same pricing gate as a broadcast — deliberately,
    // so a campaign sent one recipient at a time is not cheaper in permission or money terms.
    await grantPricingAndHeadroom(orgId);

    // A UTILITY template: transactional content, gated on suppression only — which is the honest
    // choice for a thread where the customer wrote first and no marketing consent exists.
    await openOrgPage(
      page,
      '/commerce/campaigns',
      orgId,
      page.getByRole('heading', { name: 'Templates', exact: true }),
    );
    const templateName = `order_ready_${Date.now()}`;
    await submitApprovedTemplate(page, {
      name: templateName,
      body: 'Your order {{1}} is ready for pickup.',
      category: 'utility',
    });

    const question = `Is my order ready? ${randomUUID().slice(0, 8)}`;
    await deliverInbound({ orgId, wabaId, from: '15551230003', text: question });

    await openOrgPage(
      page,
      '/commerce',
      orgId,
      page.getByRole('heading', { name: 'Inbox', exact: true }),
    );
    await page.getByText('Dana Customer').click();
    await expect(page.getByText(question).first()).toBeVisible();

    const sendsBefore = await outboundSendCount();
    await page
      .locator('select')
      .filter({ hasText: 'Send a template…' })
      .selectOption({ label: `${templateName} (en_US)` });
    // The page says which consent regime this send rides under, next to the button that spends it.
    await expect(page.getByText('Transactional template — needs no marketing consent.')).toBeVisible();
    await page.getByPlaceholder('Value for {{1}}').fill('A-42');
    await page.getByRole('button', { name: 'Send template' }).click();

    // The rendered body — placeholders filled — lands in the thread, and the send really reached
    // Meta rather than stopping at the database.
    await expect(page.getByText('Your order A-42 is ready for pickup.').first()).toBeVisible();
    expect(
      (await outboundSendCount()) - sendsBefore,
      'the template send must reach Meta, not just the database',
    ).toBeGreaterThan(0);
  });
});
