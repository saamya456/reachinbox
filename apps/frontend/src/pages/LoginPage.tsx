import { Navigate, useSearchParams } from 'react-router';
import { authApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthProvider';
import { Spinner } from '../components/ui/Spinner';

// Error codes the backend's OAuth callback can redirect with.
const ERRORS: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  invalid_state: 'The sign-in link expired or was opened in another browser. Please try again.',
  invalid_request: 'The sign-in response was incomplete. Please try again.',
  email_not_verified: 'Your Google account email is not verified.',
  account_conflict: 'This email is already linked to a different Google account.',
  not_configured: 'Google sign-in is not configured on this server.',
  token_exchange_failed: 'Google sign-in failed. Please try again.',
  invalid_id_token: 'Google sign-in could not be verified. Please try again.',
};

function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/scheduled';
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.6-.2-2.3H12v4.4h6.5c-.1 1.1-.9 2.8-2.5 3.9l3.8 3c2.3-2.1 3.7-5.2 3.7-9z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.8-3c-1 .7-2.4 1.2-4.2 1.2-3.2 0-5.9-2.1-6.9-5l-4 3.1C3.1 21.3 7.2 24 12 24z" />
      <path fill="#FBBC05" d="M5.1 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3L1.1 6.6C.4 8.2 0 10 0 12s.4 3.8 1.1 5.4l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c2.3 0 3.8 1 4.7 1.8l3.4-3.3C18 1.2 15.2 0 12 0 7.2 0 3.1 2.7 1.1 6.6l4 3.1c1-2.9 3.7-4.9 6.9-4.9z" />
    </svg>
  );
}

export function LoginPage() {
  const { state } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const error = params.get('error');

  if (state.status === 'authenticated') return <Navigate to={next} replace />;

  return (
    <div className="flex min-h-full items-center justify-center bg-white px-4 py-10">
      <div className="w-full max-w-[400px] rounded-2xl border border-line bg-white px-8 py-10 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <h1 className="text-center text-[26px] font-bold tracking-tight text-ink">Login</h1>
        {error && (
          <p role="alert" className="mt-5 rounded-lg bg-danger-soft px-3 py-2 text-center text-[12px] text-danger">
            {ERRORS[error] ?? 'Sign-in failed. Please try again.'}
          </p>
        )}
        <a
          href={authApi.googleLoginUrl(next)}
          aria-disabled={state.status === 'loading'}
          className="mt-7 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand-soft text-[13px] font-medium text-ink transition-colors hover:bg-[#d8efe1] focus-visible:outline-2 focus-visible:outline-brand"
        >
          {state.status === 'loading' ? <Spinner className="size-4" /> : <GoogleIcon />}
          Login with Google
        </a>
        <p className="mt-5 text-center text-[11px] leading-relaxed text-muted">
          Sign in with your Google account. Your session is kept in a secure, HttpOnly cookie.
        </p>
      </div>
    </div>
  );
}
