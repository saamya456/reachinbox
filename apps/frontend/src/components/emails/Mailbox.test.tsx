import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledPage, SentPage } from '../../pages/MailboxPages';
import { emptySearch, mockApi, renderApp, TEST_USER } from '../../test/utils';

const item = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  recipientEmail: 'john@acme.io',
  subject: 'Meeting follow-up',
  snippet: 'Hi John, just wanted to follow up',
  status: 'SCHEDULED',
  scheduledAt: '2026-10-06T09:15:12Z',
  sentAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  rescheduleCount: 0,
  previewUrl: null,
  errorCode: null,
  sender: { id: 's', email: 'sales@x.io', displayName: null },
  campaign: { id: 'c', subject: 'Meeting follow-up' },
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('Mailbox', () => {
  it('shows a loading skeleton, then the rows from the search API', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const api = mockApi({
      'GET /auth/me': () => ({ body: TEST_USER }),
      'GET /api/emails/search': async (url) => {
        if (url.searchParams.get('limit') === '1') return { body: { ...emptySearch, total: 1 } };
        await gate;
        return { body: { items: [item()], page: 1, limit: 25, total: 1 } };
      },
    });
    renderApp(<ScheduledPage />, { route: '/scheduled', path: '/scheduled' });
    expect(await screen.findByLabelText('Loading')).toBeInTheDocument();
    release();
    expect(await screen.findByText('Meeting follow-up')).toBeInTheDocument();
    expect(screen.getByText('john@acme.io')).toBeInTheDocument();
    expect(screen.getByTitle('Scheduled')).toBeInTheDocument();
    const listCall = api.calls.find((c) => c.path === '/api/emails/search' && c.method === 'GET');
    expect(listCall).toBeTruthy();
  });

  it('asks the server for the scheduled statuses, sorted by scheduled time, page by page', async () => {
    const urls: URL[] = [];
    mockApi({
      'GET /auth/me': () => ({ body: TEST_USER }),
      'GET /api/emails/search': (url) => {
        urls.push(url);
        return { body: { items: [item()], page: Number(url.searchParams.get('page')), limit: 25, total: 60 } };
      },
    });
    const user = userEvent.setup();
    renderApp(<ScheduledPage />, { route: '/scheduled', path: '/scheduled' });
    await screen.findByText('1–25 of 60');
    const list = urls.find((u) => u.searchParams.get('limit') === '25')!;
    expect(list.searchParams.get('status')).toBe('SCHEDULED,PROCESSING');
    expect(list.searchParams.get('sort')).toBe('scheduledAt');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('26–50 of 60');
    expect(urls.at(-1)!.searchParams.get('page')).toBe('2');
  });

  it('right after scheduling, refreshes by itself until the new emails are indexed', async () => {
    let listCalls = 0;
    mockApi({
      'GET /auth/me': () => ({ body: TEST_USER }),
      'GET /api/emails/search': (url) => {
        if (url.searchParams.get('limit') === '1') return { body: emptySearch };
        listCalls++;
        // The first response predates indexing; the next ones include the email.
        return listCalls === 1 ? { body: emptySearch } : { body: { items: [item()], page: 1, limit: 25, total: 1 } };
      },
    });
    renderApp(<ScheduledPage />, { route: '/scheduled', path: '/scheduled', state: { justScheduled: 1 } });
    expect(await screen.findByText('Adding your newly scheduled emails…')).toBeInTheDocument();
    expect(await screen.findByText('Meeting follow-up', {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });

  it('shows the empty state when there are no emails', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: TEST_USER }), 'GET /api/emails/search': () => ({ body: emptySearch }) });
    renderApp(<SentPage />, { route: '/sent', path: '/sent' });
    expect(await screen.findByText('No sent emails yet')).toBeInTheDocument();
  });

  it('shows an error state with retry when search is unavailable', async () => {
    let fail = true;
    mockApi({
      'GET /auth/me': () => ({ body: TEST_USER }),
      'GET /api/emails/search': () =>
        fail
          ? { status: 503, body: { error: { code: 'search_unavailable', message: 'Email search is temporarily unavailable' } } }
          : { body: { items: [item({ status: 'SENT', sentAt: '2026-10-06T10:00:00Z' })], page: 1, limit: 25, total: 1 } },
    });
    const user = userEvent.setup();
    renderApp(<SentPage />, { route: '/sent', path: '/sent' });
    expect(await screen.findByText('Email search is temporarily unavailable')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Sent')).toBeInTheDocument());
  });

  it('presents failed and unknown delivery honestly in Sent', async () => {
    mockApi({
      'GET /auth/me': () => ({ body: TEST_USER }),
      'GET /api/emails/search': () => ({
        body: {
          items: [
            item({ id: 'a', status: 'FAILED', sentAt: null, subject: 'Rejected one' }),
            item({ id: 'b', status: 'DELIVERY_UNKNOWN', sentAt: null, subject: 'Unclear one' }),
          ],
          page: 1,
          limit: 25,
          total: 2,
        },
      }),
    });
    renderApp(<SentPage />, { route: '/sent', path: '/sent' });
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText(/^Sent$/)).not.toBeInTheDocument();
  });
});
