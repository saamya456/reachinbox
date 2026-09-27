import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Clock, LayoutDashboard, LogOut, Send, Settings } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { useMailboxCounts } from '../../hooks/useMailboxCounts';
import { Avatar } from '../ui/Avatar';
import { Logo } from './Logo';

function NavItem({ to, icon, label, count }: { to: string; icon: ReactNode; label: string; count?: number | null }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors ${
          isActive ? 'bg-brand-soft font-medium text-ink' : 'text-ink-2 hover:bg-field'
        }`
      }
    >
      <span className="text-ink-2">{icon}</span>
      <span className="flex-1">{label}</span>
      {count != null && <span className="text-[12px] text-muted tabular-nums">{count.toLocaleString()}</span>}
    </NavLink>
  );
}

function UserCard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!user) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-xl bg-field px-2.5 py-2 text-left hover:bg-[#ededee]"
      >
        <Avatar src={user.avatarUrl} name={user.name ?? user.email} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{user.name ?? user.email}</span>
          <span className="block truncate text-[11px] text-muted">{user.email}</span>
        </span>
        <ChevronDown className={`size-4 text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-lg">
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              navigate('/settings');
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-field"
          >
            <Settings className="size-4 text-muted" aria-hidden="true" /> Settings
          </button>
          {user.isAdmin && (
            <a role="menuitem" href="/admin/queues" target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2 hover:bg-field">
              <LayoutDashboard className="size-4 text-muted" aria-hidden="true" /> Queue dashboard
            </a>
          )}
          <button
            role="menuitem"
            type="button"
            onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-danger hover:bg-danger-soft"
          >
            <LogOut className="size-4" aria-hidden="true" /> Log out
          </button>
        </div>
      )}
    </div>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const counts = useMailboxCounts();
  const navigate = useNavigate();
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-4 px-3 py-4" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <div className="px-1.5 pt-0.5">
        <Logo />
      </div>
      <UserCard />
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          navigate('/compose');
        }}
        className="h-9 w-full rounded-full border border-brand bg-white text-[13px] font-semibold text-brand-strong transition-colors hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-brand"
      >
        Compose
      </button>
      <div>
        <p className="mb-1.5 px-2.5 text-[10px] font-medium tracking-wider text-faint uppercase">Core</p>
        <div className="flex flex-col gap-0.5">
          <NavItem to="/scheduled" icon={<Clock className="size-4" />} label="Scheduled" count={counts.scheduled} />
          <NavItem to="/sent" icon={<Send className="size-4" />} label="Sent" count={counts.sent} />
        </div>
      </div>
      <div className="mt-auto">
        <NavItem to="/settings" icon={<Settings className="size-4" />} label="Settings" />
      </div>
    </nav>
  );
}
