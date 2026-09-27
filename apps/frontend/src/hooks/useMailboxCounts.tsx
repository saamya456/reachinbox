import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { emailsApi } from '../api/endpoints';
import type { EmailStatus } from '../types/api';

// Status groups behind the two dashboard tabs.
export const SCHEDULED_STATUSES: EmailStatus[] = ['SCHEDULED', 'PROCESSING'];
export const SENT_STATUSES: EmailStatus[] = ['SENT', 'FAILED', 'DELIVERY_UNKNOWN'];

interface Counts {
  scheduled: number | null;
  sent: number | null;
  refresh: () => void;
}

const CountsContext = createContext<Counts | null>(null);

// Sidebar totals (Figma: "Scheduled 12", "Sent 745"), from Elasticsearch
// search totals scoped to the signed-in user by the backend.
export function MailboxCountsProvider({ children }: { children: ReactNode }) {
  const [scheduled, setScheduled] = useState<number | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const total = (status: EmailStatus[]) =>
      emailsApi
        .search({ status, page: 1, limit: 1, sort: 'createdAt', order: 'desc' }, controller.signal)
        .then((r) => r.total)
        .catch(() => null);
    void total(SCHEDULED_STATUSES).then((n) => !controller.signal.aborted && setScheduled(n));
    void total(SENT_STATUSES).then((n) => !controller.signal.aborted && setSent(n));
    return () => controller.abort();
  }, [version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ scheduled, sent, refresh }), [scheduled, sent, refresh]);
  return <CountsContext.Provider value={value}>{children}</CountsContext.Provider>;
}

export function useMailboxCounts(): Counts {
  const ctx = useContext(CountsContext);
  if (!ctx) throw new Error('useMailboxCounts must be used inside MailboxCountsProvider');
  return ctx;
}
