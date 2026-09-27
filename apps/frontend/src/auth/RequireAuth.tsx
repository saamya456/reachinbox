import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Spinner } from '../components/ui/Spinner';
import { useAuth } from './AuthProvider';

// Protected routes: anonymous visitors are sent to /login (remembering where
// they wanted to go). The backend enforces authentication on every API call
// regardless; this only keeps the UI consistent.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner className="size-5" label="Checking your session" />
      </div>
    );
  }
  if (state.status === 'anonymous') {
    const next = location.pathname + location.search;
    return <Navigate to={`/login${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} replace />;
  }
  return <>{children}</>;
}
