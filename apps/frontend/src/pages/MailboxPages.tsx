import { Mailbox } from '../components/emails/Mailbox';
import { SCHEDULED_STATUSES, SENT_STATUSES } from '../hooks/useMailboxCounts';

export function ScheduledPage() {
  return (
    <Mailbox
      config={{
        mode: 'scheduled',
        statuses: SCHEDULED_STATUSES,
        sort: 'scheduledAt',
        order: 'asc',
        emptyTitle: 'No scheduled emails',
        emptyDescription: 'Emails you schedule appear here until they are sent.',
      }}
    />
  );
}

export function SentPage() {
  return (
    <Mailbox
      config={{
        mode: 'sent',
        statuses: SENT_STATUSES,
        sort: 'sentAt',
        order: 'desc',
        emptyTitle: 'No sent emails yet',
        emptyDescription: 'Delivered and failed emails appear here.',
      }}
    />
  );
}
