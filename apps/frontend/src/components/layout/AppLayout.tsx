import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { Outlet } from 'react-router';
import { MailboxCountsProvider } from '../../hooks/useMailboxCounts';
import { IconButton } from '../ui/Button';
import { Logo } from './Logo';
import { Sidebar } from './Sidebar';

// App shell: fixed sidebar on desktop, slide-over drawer on small screens.
export function AppLayout() {
  const [drawer, setDrawer] = useState(false);
  return (
    <MailboxCountsProvider>
      <div className="flex h-full min-h-0">
        <aside className="hidden w-[220px] shrink-0 border-r border-line bg-white md:block">
          <Sidebar />
        </aside>

        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="absolute inset-0 bg-black/20" onClick={() => setDrawer(false)} />
            <aside className="relative h-full w-[260px] bg-white shadow-xl">
              <IconButton label="Close menu" className="absolute top-3 right-3" onClick={() => setDrawer(false)}>
                <X className="size-4" />
              </IconButton>
              <Sidebar onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 items-center gap-2 border-b border-line px-3 md:hidden">
            <IconButton label="Open menu" onClick={() => setDrawer(true)}>
              <Menu className="size-5" />
            </IconButton>
            <Logo />
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </MailboxCountsProvider>
  );
}
