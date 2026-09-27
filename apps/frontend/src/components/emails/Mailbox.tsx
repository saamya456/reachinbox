import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Filter, RotateCw, Search } from 'lucide-react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { emailsApi, type EmailSearchParams } from '../../api/endpoints';
import { useAsync, useDebouncedValue } from '../../hooks/useAsync';
import { useMailboxCounts } from '../../hooks/useMailboxCounts';
import type { EmailStatus } from '../../types/api';
import { UserChip } from '../layout/UserChip';
import { Button, IconButton } from '../ui/Button';
import { EmptyState, ErrorState, ListSkeleton } from '../ui/States';
import { statusLabel } from '../ui/StatusPill';
import { EmailRow } from './EmailRow';

export interface MailboxConfig {
  mode: 'scheduled' | 'sent';
  statuses: EmailStatus[];
  sort: EmailSearchParams['sort'];
  order: EmailSearchParams['order'];
  emptyTitle: string;
  emptyDescription: string;
}

const PAGE_SIZE = 25;

// Scheduled / Sent list. Everything comes from GET /api/emails/search
// (Elasticsearch, tenant-scoped on the server) with server-side paging; the
// query, filter and page live in the URL so views are shareable and survive reload.
export function Mailbox({ config }: { config: MailboxConfig }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const counts = useMailboxCounts();
  const location = useLocation();
  const justScheduled = (location.state as { justScheduled?: number } | null)?.justScheduled;
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const statusParam = params.get('status');
  const statuses = statusParam
    ? (statusParam.split(',').filter((s) => config.statuses.includes(s as EmailStatus)) as EmailStatus[])
    : config.statuses;

  const [input, setInput] = useState(q);
  const debounced = useDebouncedValue(input, 300);
  useEffect(() => setInput(q), [q]);
  useEffect(() => {
    if (debounced === q) return;
    const next = new URLSearchParams(params);
    if (debounced) next.set('q', debounced);
    else next.delete('q');
    next.delete('page');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const { data, loading, error, reload } = useAsync(
    (signal) =>
      emailsApi.search(
        {
          q,
          status: statuses.length ? statuses : config.statuses,
          page,
          limit: PAGE_SIZE,
          sort: q ? 'relevance' : config.sort,
          order: config.order,
        },
        signal,
      ),
    [q, page, statuses.join(','), config.mode],
  );

  const setPage = (n: number) => {
    const next = new URLSearchParams(params);
    if (n > 1) next.set('page', String(n));
    else next.delete('page');
    setParams(next);
  };

  // Right after scheduling, the new emails reach the search index a moment
  // later (eventual consistency): re-fetch twice, then stop. Not a poller.
  const [catchingUp, setCatchingUp] = useState(false);
  useEffect(() => {
    if (!justScheduled) return;
    setCatchingUp(true);
    const timers = [1_500, 4_000].map((ms, i, all) =>
      window.setTimeout(() => {
        reload();
        counts.refresh();
        if (i === all.length - 1) setCatchingUp(false);
      }, ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justScheduled]);

  const refresh = () => {
    reload();
    counts.refresh();
  };

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 px-4 py-3">
        <label className="relative flex max-w-[640px] flex-1 items-center">
          <span className="sr-only">Search {config.mode} emails</span>
          <Search className="pointer-events-none absolute left-3 size-4 text-faint" aria-hidden="true" />
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search"
            className="h-9 w-full rounded-lg bg-field pr-3 pl-9 text-[13px] text-ink placeholder:text-faint focus:ring-2 focus:ring-brand/30 focus:outline-none"
          />
        </label>
        <StatusFilter all={config.statuses} selected={statuses} onChange={(s) => {
          const next = new URLSearchParams(params);
          if (s.length && s.length < config.statuses.length) next.set('status', s.join(','));
          else next.delete('status');
          next.delete('page');
          setParams(next);
        }} />
        <IconButton label="Refresh" onClick={refresh} disabled={loading}>
          <RotateCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </IconButton>
        <div className="ml-auto">
          <UserChip />
        </div>
      </header>

      {catchingUp && (
        <p role="status" className="mx-4 mb-2 rounded-lg bg-brand-soft px-3 py-2 text-[12px] text-brand-strong">
          Adding your newly scheduled emails…
        </p>
      )}
      <section aria-label={config.mode === 'scheduled' ? 'Scheduled emails' : 'Sent emails'} className="min-h-0 flex-1 overflow-y-auto">
        {loading && !data ? (
          <ListSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data || data.items.length === 0 ? (
          q || statusParam ? (
            <EmptyState title="No matching emails" description="Try a different search or filter." />
          ) : (
            <EmptyState
              title={config.emptyTitle}
              description={config.emptyDescription}
              action={
                <Button variant="outline" pill onClick={() => navigate('/compose')}>
                  Compose New Email
                </Button>
              }
            />
          )
        ) : (
          <ul className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
            {data.items.map((email) => (
              <EmailRow key={email.id} email={email} mode={config.mode} />
            ))}
          </ul>
        )}
      </section>

      {data && total > 0 && (
        <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-[12px] text-muted">
          <span className="tabular-nums">
            {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
          </span>
          <IconButton label="Previous page" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <IconButton label="Next page" disabled={to >= total || loading} onClick={() => setPage(page + 1)}>
            <ChevronRight className="size-4" />
          </IconButton>
        </footer>
      )}
    </div>
  );
}

function StatusFilter({ all, selected, onChange }: { all: EmailStatus[]; selected: EmailStatus[]; onChange: (s: EmailStatus[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const active = selected.length < all.length;
  return (
    <div ref={ref} className="relative">
      <IconButton label="Filter by status" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={active ? 'text-brand-strong' : ''}>
        <Filter className="size-4" />
      </IconButton>
      {open && (
        <div className="absolute top-full right-0 z-20 mt-1 w-44 rounded-xl border border-line bg-white p-1.5 shadow-lg">
          <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted">Status</p>
          {all.map((status) => {
            const checked = selected.includes(status);
            return (
              <label key={status} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-field">
                <input
                  type="checkbox"
                  checked={checked}
                  className="accent-[var(--color-brand)]"
                  onChange={() => {
                    const next = checked ? selected.filter((s) => s !== status) : [...selected, status];
                    onChange(next.length ? next : all);
                  }}
                />
                {statusLabel(status)}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
