import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { ToastProvider } from '../components/ui/Toast';
import { MailboxCountsProvider } from '../hooks/useMailboxCounts';

export const TEST_USER = { id: 'u1', name: 'Oliver Brown', email: 'oliver@example.com', avatarUrl: null, isAdmin: false };

type Handler = (url: URL, init: RequestInit) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

// Stubs fetch with a router: first matching "METHOD /path" key wins.
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && (p === url.pathname || (p!.endsWith('*') && url.pathname.startsWith(p!.slice(0, -1))));
    });
    const result = key ? await routes[key]!(url, init) : { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
    const status = result.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(result.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

export function renderApp(
  ui: ReactElement,
  { route = '/', path = '*', state }: { route?: string; path?: string; state?: unknown } = {},
) {
  return render(
    <MemoryRouter initialEntries={[state === undefined ? route : { pathname: route.split('?')[0]!, search: route.includes('?') ? route.slice(route.indexOf('?')) : '', state }]}>
      <ToastProvider>
        <AuthProvider>
          <MailboxCountsProvider>
            <Routes>
              <Route path={path} element={ui} />
              {/* Other routes render nothing; the probe below reports where we are. */}
              <Route path="*" element={null} />
            </Routes>
            <LocationProbe />
          </MailboxCountsProvider>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

export const emptySearch = { items: [], page: 1, limit: 25, total: 0 };
