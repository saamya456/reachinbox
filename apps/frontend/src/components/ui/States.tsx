import type { ReactNode } from 'react';
import { AlertCircle, Inbox } from 'lucide-react';
import { Button } from './Button';

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-field text-muted">
        <Inbox className="size-5" aria-hidden="true" />
      </div>
      <p className="text-[14px] font-semibold text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertCircle className="size-5" aria-hidden="true" />
      </div>
      <p className="text-[14px] font-semibold text-ink">Couldn&apos;t load this</p>
      <p className="mt-1 max-w-sm text-muted">{message}</p>
      {onRetry && (
        <Button variant="outline" pill size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// Placeholder rows shaped like the list, so loading does not shift the layout.
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-12 items-center gap-4 border-b border-line px-4">
          <div className="h-3 w-32 rounded bg-field" />
          <div className="h-5 w-24 rounded-full bg-field" />
          <div className="h-3 flex-1 rounded bg-field" />
        </div>
      ))}
    </div>
  );
}
