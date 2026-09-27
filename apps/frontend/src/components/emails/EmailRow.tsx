import { Link } from 'react-router';
import type { EmailListItem } from '../../types/api';
import { formatShort } from '../../utils/format';
import { StatusPill } from '../ui/StatusPill';

// One mailbox row, laid out as in the Figma:
//   To: recipient | status pill | subject - snippet | time
export function EmailRow({ email, mode }: { email: EmailListItem; mode: 'scheduled' | 'sent' }) {
  const time = mode === 'sent' ? email.sentAt : null;
  return (
    <li className="border-b border-line">
      <Link
        to={`/emails/${email.id}`}
        className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 transition-colors hover:bg-panel focus-visible:bg-panel focus-visible:outline-none sm:flex-nowrap md:gap-x-4"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink sm:w-40 sm:flex-none sm:shrink-0 lg:w-52">
          <span className="text-ink-2">To: </span>
          {email.recipientEmail}
        </span>
        <StatusPill status={email.status} scheduledAt={email.scheduledAt} />
        <span className="min-w-0 basis-full truncate sm:basis-auto sm:flex-1">
          <span className="font-semibold text-ink">{email.subject}</span>
          {email.snippet && <span className="text-muted"> - {email.snippet}</span>}
        </span>
        {mode === 'scheduled' && email.rescheduleCount > 0 && (
          <span className="hidden shrink-0 rounded-full bg-field px-2 py-0.5 text-[11px] text-muted sm:inline" title="Moved to a later hour by the hourly limit">
            Rescheduled
          </span>
        )}
        {time && (
          <time dateTime={time} className="hidden shrink-0 text-[12px] text-muted tabular-nums sm:inline">
            {formatShort(time)}
          </time>
        )}
      </Link>
    </li>
  );
}
