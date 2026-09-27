import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onUnauthorized } from '../api/client';
import { authApi } from '../api/endpoints';
import type { User } from '../types/api';

// The session lives in an HttpOnly cookie set by the backend's Google OAuth
// callback; the browser never sees a token. This provider only asks the
// backend who the current user is (/auth/me) and reacts to 401s.

type AuthState = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: User };

interface AuthApi {
  state: AuthState;
  user: User | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const user = await authApi.me();
      setState({ status: 'authenticated', user });
    } catch {
      // 401 (no session) or backend unreachable: show the login screen.
      setState({ status: 'anonymous' });
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Any 401 from any request (expired or revoked session) signs the UI out.
    return onUnauthorized(() => setState({ status: 'anonymous' }));
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setState({ status: 'anonymous' });
    }
  }, []);

  const api = useMemo<AuthApi>(
    () => ({ state, user: state.status === 'authenticated' ? state.user : null, refresh, logout }),
    [state, refresh, logout],
  );
  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
