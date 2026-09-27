import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { AppLayout } from './components/layout/AppLayout';
import { Spinner } from './components/ui/Spinner';
import { ToastProvider } from './components/ui/Toast';
import { EmailDetailPage } from './pages/EmailDetailPage';
import { LoginPage } from './pages/LoginPage';
import { ScheduledPage, SentPage } from './pages/MailboxPages';
import { SettingsPage } from './pages/SettingsPage';

// The rich-text editor is the heaviest dependency; load it with the compose page only.
const ComposePage = lazy(() => import('./pages/ComposePage').then((m) => ({ default: m.ComposePage })));

const pageFallback = (
  <div className="flex h-full items-center justify-center text-muted">
    <Spinner className="size-5" label="Loading" />
  </div>
);

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/scheduled" replace />} />
        <Route path="/scheduled" element={<ScheduledPage />} />
        <Route path="/sent" element={<SentPage />} />
        <Route path="/emails/:id" element={<EmailDetailPage />} />
        <Route
          path="/compose"
          element={
            <Suspense fallback={pageFallback}>
              <ComposePage />
            </Suspense>
          }
        />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/scheduled" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
