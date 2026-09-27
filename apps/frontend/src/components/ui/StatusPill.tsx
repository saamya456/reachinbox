import { AlertTriangle, Ban, Clock, Loader2 } from 'lucide-react';
import type { EmailStatus } from '../../types/api';
import { formatPillTime } from '../../utils/format';

// Status presentation. The assignment's Sent view uses sent / failed; the
// backend can also report DELIVERY_UNKNOWN (the SMTP outcome could not be
// confirmed and the email is deliberately never re-sent). That is shown as
// "Unknown", never as "Sent".
const LABELS: Record<EmailStatus, string> = {
  SCHEDULED: 'Scheduled',
  PROCESSING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  DELIVERY_UNKNOWN: 'Unknown',
};

export const statusLabel = (status: EmailStatus) => LABELS[status];

export function StatusPill({ status, scheduledAt }: { status: EmailStatus; scheduledAt?: string }) {
  const base = 'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap';
  switch (status) {
    case 'SCHEDULED':
      return (
        <span className={`${base} bg-warn-soft text-warn`} title="Scheduled">
          <Clock className="size-3" aria-hidden="true" />
          <span className="sr-only">Scheduled for </span>
          {scheduledAt ? formatPillTime(scheduledAt) : 'Scheduled'}
        </span>
      );
    case 'PROCESSING':
      return (
        <span className={`${base} bg-info-soft text-info`}>
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          Sending
        </span>
      );
    case 'SENT':
      return <span className={`${base} bg-field text-ink-2`}>Sent</span>;
    case 'FAILED':
      return <span className={`${base} bg-danger-soft text-danger`}>Failed</span>;
    case 'DELIVERY_UNKNOWN':
      return (
        <span className={`${base} bg-amber-soft text-amber`} title="The mail server's answer was lost; it was not re-sent to avoid a duplicate.">
          <AlertTriangle className="size-3" aria-hidden="true" />
          Unknown
        </span>
      );
    case 'CANCELLED':
      return (
        <span className={`${base} bg-field text-muted`}>
          <Ban className="size-3" aria-hidden="true" />
          Cancelled
        </span>
      );
  }
}
