// Browser end-to-end check of the running stack: real API, worker, Redis,
// PostgreSQL, Elasticsearch and Ethereal SMTP. The session comes from
// E2E_SESSION (a real Google login's cookie, or `npm run dev:session`).
// Run in two parts around a restart of the API + worker:
//   npx playwright test --grep @before-restart
//   (restart API and worker)
//   npx playwright test --grep @after-restart
import fs from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SESSION = process.env.E2E_SESSION ?? '';
const SCREENS = process.env.E2E_SCREENS ?? 'screens';
const STATE_FILE = '.state.json';
const TZ = process.env.E2E_TIMEZONE ?? 'Asia/Kolkata';

type State = { runId: string; firstCampaign?: string; futureCampaign?: string; futureStartAt?: string };
const readState = (): State => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State;
const writeState = (s: State) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

async function signIn(context: BrowserContext) {
  expect(SESSION, 'E2E_SESSION must be set').not.toBe('');
  await context.addCookies([{ name: 'ri_sid', value: SESSION, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${SCREENS}/${name}.png` });

// "YYYY-MM-DDTHH:mm" in a time zone, for the datetime-local input.
function localInput(date: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

interface CampaignDetail {
  id: string;
  subject: string;
  startAt: string;
  status: string;
  totalEmails: number;
  emailCounts: Record<string, number>;
  emails: { id: string; recipientEmail: string; status: string; deliveryStartedAt: string | null; sentAt: string | null; previewUrl: string | null; rescheduleCount: number; scheduledAt: string }[];
}

async function campaign(page: Page, id: string): Promise<CampaignDetail> {
  const res = await page.request.get(`/api/campaigns/${id}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as CampaignDetail;
}

async function compose(page: Page, { recipients, subject, body }: { recipients: string[]; subject: string; body: string }) {
  await page.goto('/compose');
  await expect(page.getByRole('combobox', { name: 'From' })).toBeVisible();
  await page.getByLabel('Recipients').fill(recipients.join(', ') + ',');
  await page.getByLabel('Recipients').press('Enter');
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Email body' }).click();
  await page.keyboard.type(body);
}

test.describe.serial('@before-restart', () => {
  test.beforeAll(() => {
    fs.mkdirSync(SCREENS, { recursive: true });
    writeState({ runId: Date.now().toString(36) });
  });

  test('anonymous visitors land on the Google login page', async ({ page }) => {
    await page.goto('/scheduled');
    await expect(page).toHaveURL(/\/login/);
    const google = page.getByRole('link', { name: /Login with Google/ });
    await expect(google).toHaveAttribute('href', /^\/auth\/google\?returnTo=/);
    await expect(page.getByLabel(/password/i)).toHaveCount(0);
    await shot(page, '01-login');
  });

  test('settings: create a real Ethereal sender; Slack card reflects backend status', async ({ page, context }) => {
    await signIn(context);
    await page.goto('/settings');
    const sendersCard = page.locator('section', { has: page.getByRole('heading', { name: 'Senders' }) });
    const rows = sendersCard.getByRole('listitem');
    await expect(sendersCard.getByRole('list')).toBeVisible(); // loaded (not the skeleton)
    const existing = await sendersCard.getByRole('listitem').filter({ hasText: '@' }).count();
    await page.getByRole('button', { name: 'New Ethereal sender' }).click();
    await expect(page.getByText(/Ethereal sender .*@ethereal\.email created/)).toBeVisible({ timeout: 30_000 });
    await expect(rows.filter({ hasText: '@ethereal.email' })).toHaveCount(existing + 1);
    const slack = await (await page.request.get('/slack/status')).json();
    if (slack.configured) await expect(page.getByRole('link', { name: /Connect Slack|Reconnect Slack/ })).toHaveAttribute('href', /\/slack\/connect/);
    else await expect(page.getByText('Not connected')).toBeVisible();
    await shot(page, '02-settings');
  });

  test('compose: chips + CSV upload, delay 3 s, hourly limit 5, send now', async ({ page, context }) => {
    await signIn(context);
    const { runId } = readState();
    await page.goto('/compose');
    await expect(page.getByRole('combobox', { name: 'From' })).toBeVisible();
    await shot(page, '03-compose-empty');

    await page.getByLabel('Recipients').fill('lead.one@example.com, lead.two@example.com,');
    await page.getByLabel('Upload lead list').setInputFiles({
      name: 'leads.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('email,name\nlead.three@example.com,Three\nlead.four@example.com,Four\nnot-an-email,Bad\nlead.five@example.com,Five\nlead.six@example.com,Six\nlead.seven@example.com,Seven\nlead.one@example.com,One again\n'),
    });
    await expect(page.getByText('leads.csv: 6 emails detected')).toBeVisible();
    await expect(page.getByText('7 recipients')).toBeVisible();
    await expect(page.getByText('1 invalid row skipped')).toBeVisible();
    await expect(page.getByText('1 duplicate removed')).toBeVisible();

    await page.getByLabel('Subject').fill(`E2E launch ${runId}`);
    await page.getByRole('textbox', { name: 'Email body' }).click();
    await page.keyboard.type('Hello from the end-to-end run. ');
    await page.getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.type('This part is bold.');
    await page.getByLabel(/Delay between 2 emails/).fill('3');
    await page.getByLabel(/Hourly Limit/).fill('5');
    await shot(page, '04-compose-filled');

    await page.getByRole('button', { name: 'Send Later', exact: true }).click();
    const popover = page.getByRole('dialog', { name: 'Send later' });
    await expect(popover).toBeVisible();
    await shot(page, '05-send-later');
    await popover.getByRole('button', { name: 'Now' }).click();

    await expect(page).toHaveURL(/\/scheduled/, { timeout: 30_000 });
    await expect(page.getByText('Scheduled 7 emails.')).toBeVisible();
    const campaigns = (await (await page.request.get('/api/campaigns')).json()) as { id: string; subject: string }[];
    const created = campaigns.find((c) => c.subject === `E2E launch ${runId}`)!;
    expect(created).toBeTruthy();
    writeState({ ...readState(), firstCampaign: created.id });
  });

  test('scheduled view, queue dashboard, real delivery, rate limit and search', async ({ page, context }) => {
    await signIn(context);
    const { firstCampaign, runId } = readState();
    await page.goto('/scheduled');
    await expect(page.getByRole('link', { name: /E2E launch/ }).first()).toBeVisible({ timeout: 20_000 });
    await shot(page, '06-scheduled');

    const queues = (await (await page.request.get('/api/admin/queues')).json()) as { queues: { name: string; counts: Record<string, number> }[] };
    expect(queues.queues.map((q) => q.name)).toEqual(expect.arrayContaining(['email-scheduler', 'slack-notifications', 'search-index']));
    await page.goto('/admin/queues');
    await expect(page.getByText('email-scheduler').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });
    await shot(page, '07-bull-board');

    // Worker: 3 s apart, hourly limit 5 -> 5 sent now, 2 moved to the next hour.
    // Wait until all 7 have been attempted: 5 sent, 2 moved to the next hour
    // (emails 6 and 7 are planned 15 s and 18 s after the start).
    let detail = await campaign(page, firstCampaign!);
    const progress = (d: CampaignDetail) =>
      `${d.emailCounts.SENT} sent / ${d.emails.filter((e) => e.status === 'SCHEDULED' && e.rescheduleCount > 0).length} rescheduled`;
    await expect
      .poll(async () => ((detail = await campaign(page, firstCampaign!)), progress(detail)), { timeout: 120_000, intervals: [2_000] })
      .toBe('5 sent / 2 rescheduled');
    // Minimum delay: send authorizations (Redis gate) at least 3 s apart.
    const sent = detail.emails.filter((e) => e.status === 'SENT').sort((a, b) => a.deliveryStartedAt!.localeCompare(b.deliveryStartedAt!));
    const gaps = sent.slice(1).map((e, i) => Date.parse(e.deliveryStartedAt!) - Date.parse(sent[i]!.deliveryStartedAt!));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3_000);
    const later = detail.emails.filter((e) => e.status === 'SCHEDULED');
    expect(later.every((e) => e.rescheduleCount === 1)).toBe(true);
    const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    expect(later.every((e) => Date.parse(e.scheduledAt) >= nextHour)).toBe(true);
    for (const e of sent) {
      expect(e.previewUrl).toMatch(/^https:\/\/ethereal\.email\/message\//);
      expect((await page.request.get(e.previewUrl!)).status()).toBe(200);
    }

    await page.goto('/sent');
    await expect(page.getByRole('link', { name: new RegExp(`E2E launch ${runId}`) })).toHaveCount(5, { timeout: 20_000 });
    await shot(page, '08-sent');
    // Search narrows the list to that recipient (other runs may have mailed it too).
    await page.getByRole('searchbox', { name: /Search sent emails/ }).fill('lead.three');
    const thisRun = page.getByRole('link', { name: new RegExp(`lead\\.three@example\\.com.*E2E launch ${runId}`) });
    await expect(page).toHaveURL(/q=lead\.three/); // debounced search applied
    const results = page.getByRole('list').last().getByRole('link');
    await expect
      .poll(async () => (await results.allInnerTexts()).every((t) => t.includes('lead.three@example.com')), { timeout: 10_000 })
      .toBe(true);
    await expect(thisRun).toHaveCount(1);
    await thisRun.click();
    await expect(page.getByRole('heading', { name: new RegExp(`E2E launch ${runId}`) })).toBeVisible();
    await expect(page.getByText('This part is bold.')).toBeVisible();
    await expect(page.getByRole('link', { name: /Open message/ })).toHaveAttribute('href', /ethereal\.email\/message/);
    await shot(page, '09-detail');

    await page.goto('/scheduled');
    const rescheduledRows = page.getByRole('link', { name: new RegExp(`E2E launch ${runId}`) }).filter({ hasText: 'Rescheduled' });
    await expect(rescheduledRows).toHaveCount(2, { timeout: 20_000 });
    await shot(page, '10-scheduled-rescheduled');
  });

  test('a future campaign is scheduled at the chosen wall-clock time in the user time zone', async ({ page, context }) => {
    await signIn(context);
    const { runId } = readState();
    await compose(page, { recipients: ['restart.one@example.com', 'restart.two@example.com'], subject: `E2E restart ${runId}`, body: 'Sent after a restart.' });
    const target = new Date(Math.ceil((Date.now() + 3 * 60_000) / 60_000) * 60_000);
    await page.getByRole('button', { name: 'Send Later', exact: true }).click();
    const popover = page.getByRole('dialog', { name: 'Send later' });
    await expect(popover.getByRole('combobox')).toHaveValue(/Asia\/(Kolkata|Calcutta)/);
    await popover.locator('input[type="datetime-local"]').fill(localInput(target, TZ));
    await popover.getByRole('button', { name: 'Done' }).click();
    await expect(page).toHaveURL(/\/scheduled/, { timeout: 30_000 });

    const campaigns = (await (await page.request.get('/api/campaigns')).json()) as { id: string; subject: string; startAt: string }[];
    const created = campaigns.find((c) => c.subject === `E2E restart ${runId}`)!;
    expect(new Date(created.startAt).toISOString()).toBe(target.toISOString());
    writeState({ ...readState(), futureCampaign: created.id, futureStartAt: target.toISOString() });
    await expect(page.getByRole('link', { name: /E2E restart/ })).toHaveCount(2, { timeout: 20_000 });
    await shot(page, '11-scheduled-future');
  });
});

test.describe.serial('@after-restart', () => {
  test('after restarting API and worker, the future campaign is sent once at the right time', async ({ page, context }) => {
    test.setTimeout(360_000); // waits for the scheduled time (up to ~3 minutes)
    await signIn(context);
    const { futureCampaign, futureStartAt } = readState();
    let detail = await campaign(page, futureCampaign!);
    expect(detail.emailCounts.SCHEDULED + detail.emailCounts.SENT).toBe(2);
    await expect
      .poll(async () => ((detail = await campaign(page, futureCampaign!)), detail.emailCounts.SENT), { timeout: 300_000, intervals: [5_000] })
      .toBe(2);
    expect(detail.totalEmails).toBe(2);
    expect(detail.emails).toHaveLength(2);
    for (const e of detail.emails) {
      expect(Date.parse(e.sentAt!)).toBeGreaterThanOrEqual(Date.parse(futureStartAt!) - 1_000);
      expect(e.previewUrl).toMatch(/ethereal\.email\/message/);
    }
  });

  test('rate-limited emails are still scheduled, not duplicated or dropped', async ({ page, context }) => {
    await signIn(context);
    const detail = await campaign(page, readState().firstCampaign!);
    expect(detail.emailCounts.SENT).toBe(5);
    expect(detail.emailCounts.SCHEDULED).toBe(2);
    expect(detail.totalEmails).toBe(7);
    expect(new Set(detail.emails.map((e) => e.recipientEmail)).size).toBe(7);
  });

  test('logout ends the session on the server', async ({ page, context }) => {
    await signIn(context);
    await page.goto('/scheduled');
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login/);
    expect((await page.request.get('/auth/me')).status()).toBe(401);
    await page.goto('/sent');
    await expect(page).toHaveURL(/\/login/);
  });
});
