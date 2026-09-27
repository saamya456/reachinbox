import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserChip } from '../components/layout/UserChip';
import { LoginPage } from '../pages/LoginPage';
import { mockApi, renderApp, TEST_USER } from '../test/utils';
import { RequireAuth } from './RequireAuth';

afterEach(() => vi.unstubAllGlobals());

describe('authentication in the UI', () => {
  it('redirects anonymous visitors to /login, keeping where they were going', async () => {
    mockApi({ 'GET /auth/me': () => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'Authentication required' } } }) });
    renderApp(
      <RequireAuth>
        <p>secret page</p>
      </RequireAuth>,
      { route: '/sent?q=x', path: '/sent' },
    );
    await waitFor(() => expect(screen.getAllByTestId('location')[0]).toHaveTextContent('/login?next=%2Fsent%3Fq%3Dx'));
    expect(screen.queryByText('secret page')).not.toBeInTheDocument();
  });

  it('renders protected content with the user from /auth/me, and logout calls the backend', async () => {
    const api = mockApi({ 'GET /auth/me': () => ({ body: TEST_USER }), 'POST /auth/logout': () => ({ status: 204 }) });
    const user = userEvent.setup();
    renderApp(
      <RequireAuth>
        <UserChip />
      </RequireAuth>,
      { route: '/scheduled', path: '/scheduled' },
    );
    expect(await screen.findByText('Oliver Brown')).toBeInTheDocument();
    expect(screen.getByText('oliver@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/auth/logout')).toBe(true));
    await waitFor(() => expect(screen.getAllByTestId('location')[0]).toHaveTextContent('/login'));
  });

  it('login page links to the backend Google OAuth flow and explains errors', async () => {
    mockApi({ 'GET /auth/me': () => ({ status: 401, body: {} }) });
    renderApp(<LoginPage />, { route: '/login?error=invalid_state&next=/sent', path: '/login' });
    const link = await screen.findByRole('link', { name: /Login with Google/ });
    expect(link).toHaveAttribute('href', '/auth/google?returnTo=%2Fsent');
    expect(screen.getByRole('alert')).toHaveTextContent('expired or was opened in another browser');
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
});
