import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySearch, mockApi, renderApp, TEST_USER } from '../test/utils';
import { ComposePage, validateCompose } from './ComposePage';

// jsdom cannot drive a contenteditable editor; use a textarea with the same contract.
vi.mock('../components/compose/RichTextEditor', () => ({
  RichTextEditor: ({ onChange }: { onChange: (v: { html: string; text: string }) => void }) => (
    <textarea aria-label="Email body" onChange={(e) => onChange({ html: `<p>${e.target.value}</p>`, text: e.target.value })} />
  ),
}));

const SENDER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'sales@ethereal.email',
  displayName: null,
  smtpHost: 'smtp.ethereal.email',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: 'u',
  isActive: true,
  hourlyLimit: 100,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function baseRoutes(extra = {}) {
  return {
    'GET /auth/me': () => ({ body: TEST_USER }),
    'GET /api/emails/search': () => ({ body: emptySearch }),
    'GET /api/senders': () => ({ body: [SENDER] }),
    ...extra,
  };
}

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('combobox', { name: 'From' });
  await user.type(screen.getByLabelText('Recipients'), 'a@example.com, b@example.com,');
  await user.type(screen.getByLabelText('Subject'), 'Launch day');
  await user.type(screen.getByLabelText('Email body'), 'Hello there');
  await user.type(screen.getByLabelText(/Delay between 2 emails/), '5');
  await user.type(screen.getByLabelText(/Hourly Limit/), '50');
}

describe('validateCompose', () => {
  const base = {
    senderId: 's',
    chips: [{ value: 'a@x.com', valid: true }],
    subject: 'S',
    body: { html: '<p>B</p>', text: 'B' },
    delay: '',
    hourlyLimit: '',
  };
  it('accepts a complete form', () => expect(validateCompose(base)).toEqual({}));
  it('reports every missing or invalid field', () => {
    expect(
      validateCompose({ senderId: '', chips: [{ value: 'bad', valid: false }], subject: ' ', body: { html: '', text: ' ' }, delay: '99999', hourlyLimit: '0' }),
    ).toEqual({
      sender: 'Choose a sender',
      recipients: 'Remove 1 invalid address before scheduling',
      subject: 'Subject is required',
      body: 'Write the email body',
      delay: 'At most 3600 seconds',
      hourlyLimit: '1–10,000 emails per hour',
    });
    expect(validateCompose({ ...base, chips: [] }).recipients).toBe('Add at least one recipient');
  });
});

describe('ComposePage', () => {
  beforeEach(() => vi.stubGlobal('crypto', { ...crypto, randomUUID: () => 'req-0000-1111-2222' }));
  afterEach(() => vi.unstubAllGlobals());

  it('blocks scheduling and shows field errors when the form is incomplete', async () => {
    const user = userEvent.setup();
    const api = mockApi(baseRoutes());
    renderApp(<ComposePage />, { route: '/compose', path: '/compose' });
    await screen.findByRole('combobox', { name: 'From' });
    await user.click(screen.getByRole('button', { name: 'Send Later' }));

    expect(await screen.findByText('Add at least one recipient')).toBeInTheDocument();
    expect(screen.getByText('Subject is required')).toBeInTheDocument();
    expect(screen.getByText('Write the email body')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Send later' })).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('schedules through the API with the chosen time and navigates to Scheduled', async () => {
    const user = userEvent.setup();
    const api = mockApi(
      baseRoutes({
        'POST /api/campaigns': () => ({
          status: 201,
          body: {
            created: true,
            queued: 2,
            pendingReconciliation: 0,
            recipients: { total: 2, valid: 2, invalid: 0, duplicatesRemoved: 0, invalidEntries: [] },
            campaign: { id: 'c1', totalEmails: 2 },
          },
        }),
      }),
    );
    renderApp(<ComposePage />, { route: '/compose', path: '/compose' });
    await fillForm(user);

    await user.click(screen.getByRole('button', { name: 'Send Later' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send later' });
    await user.selectOptions(within(dialog).getByRole('combobox'), 'UTC');
    await user.click(within(dialog).getByRole('button', { name: 'Tomorrow, 10:00 AM' }));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/scheduled'));
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/campaigns')!;
    const body = post.body as Record<string, unknown>;
    expect(body).toMatchObject({
      senderId: SENDER.id,
      subject: 'Launch day',
      body: '<p>Hello there</p>',
      recipients: ['a@example.com', 'b@example.com'],
      timezone: 'UTC',
      delayBetweenEmailsSeconds: 5,
      hourlyLimit: 50,
      clientRequestId: 'req-0000-1111-2222',
    });
    expect(body.startAt).toMatch(/T10:00:00\.000Z$/);
    expect(new Date(body.startAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(await screen.findByText('Scheduled 2 emails.')).toBeInTheDocument();
  });

  it('keeps the form and shows the server error when scheduling fails', async () => {
    const user = userEvent.setup();
    mockApi(
      baseRoutes({
        'POST /api/campaigns': () => ({
          status: 400,
          body: { error: { code: 'invalid_recipients', message: '1 recipient(s) are invalid', details: { invalid: 1 } } },
        }),
      }),
    );
    renderApp(<ComposePage />, { route: '/compose', path: '/compose' });
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Send Later' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send later' });
    await user.click(within(dialog).getByRole('button', { name: 'Now' }));

    expect(await screen.findAllByText('1 recipient(s) are invalid')).not.toHaveLength(0);
    expect(screen.getByTestId('location')).toHaveTextContent('/compose');
    expect(screen.getByLabelText('Subject')).toHaveValue('Launch day');
  });

  it('"Now" sends the exact current instant, not the minute-truncated time', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2030-10-01T10:00:55.000Z'));
    try {
      const user = userEvent.setup();
      const api = mockApi(
        baseRoutes({
          'POST /api/campaigns': () => ({
            status: 201,
            body: { created: true, queued: 2, pendingReconciliation: 0, recipients: null, campaign: { id: 'c1', totalEmails: 2 } },
          }),
        }),
      );
      renderApp(<ComposePage />, { route: '/compose', path: '/compose' });
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'Send Later' }));
      await user.click(within(await screen.findByRole('dialog', { name: 'Send later' })).getByRole('button', { name: 'Now' }));
      await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/campaigns')).toBe(true));
      const body = api.calls.find((c) => c.path === '/api/campaigns')!.body as { startAt: string };
      expect(body.startAt.startsWith('2030-10-01T10:00:5')).toBe(true);
      expect(new Date(body.startAt).getUTCSeconds()).toBeGreaterThanOrEqual(55);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uploads a lead list through the server parser and shows the counts', async () => {
    const user = userEvent.setup();
    const api = mockApi(
      baseRoutes({
        'POST /api/campaigns/recipients/parse': () => ({
          body: { emails: ['x@y.com', 'z@y.com'], total: 4, valid: 2, invalid: 1, duplicatesRemoved: 1, invalidEntries: [{ row: 3, value: 'bad' }], tooMany: false },
        }),
      }),
    );
    renderApp(<ComposePage />, { route: '/compose', path: '/compose' });
    await screen.findByRole('combobox', { name: 'From' });
    await user.upload(screen.getByLabelText('Upload lead list'), new File(['email\nx@y.com\nbad\nz@y.com\nx@y.com'], 'leads.csv', { type: 'text/csv' }));

    expect(await screen.findByText('leads.csv: 2 emails detected')).toBeInTheDocument();
    expect(screen.getByText('2 recipients')).toBeInTheDocument();
    expect(screen.getByText('1 invalid row skipped')).toBeInTheDocument();
    expect(screen.getByText('1 duplicate removed')).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/api/campaigns/recipients/parse')?.body).toEqual({ text: 'email\nx@y.com\nbad\nz@y.com\nx@y.com' });
  });
});
