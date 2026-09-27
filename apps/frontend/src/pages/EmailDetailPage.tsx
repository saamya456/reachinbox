import { useMemo, useState, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { errorMessage } from '../api/client';
import { campaignsApi, emailsApi } from '../api/endpoints';
import { UserChip } from '../components/layout/UserChip';
import { Avatar } from '../components/ui/Avatar';
import { Button, IconButton } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorState, ListSkeleton } from '../components/ui/States';
import { StatusPill } from '../components/ui/StatusPill';
import { useToast } from '../components/ui/Toast';
import { useAsync } from '../hooks/useAsync';
import { useMailboxCounts } from '../hooks/useMailboxCounts';
import type { EmailDetail } from '../types/api';
import { formatDateTime } from '../utils/format';

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <dt className="w-36 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-2">{children}</dd>
    </div>
  );
}

function DeliveryNote({ email }: { email: EmailDetail }) {
  if (email.status === 'DELIVERY_UNKNOWN') {
    return (
      <p className="rounded-lg bg-amber-soft px-3 py-2 text-[12px] text-amber">
        The mail server&apos;s reply was lost while this email was being sent, so delivery can&apos;t be confirmed. It is not re-sent
        automatically, to avoid sending it twice.
      </p>
    );
  }
  if (email.status === 'FAILED') {
    return (
      <p className="rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger">
        Not delivered{email.errorMessage ? `: ${email.errorMessage}` : '.'}
      </p>
    );
  }
  return null;
}

export function EmailDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const counts = useMailboxCounts();
  const { data: email, loading, error, reload } = useAsync((signal) => emailsApi.get(id, signal), [id]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Server-sanitized HTML, purified again in the browser before rendering.
  const safeBody = useMemo(() => (email ? DOMPurify.sanitize(email.bodyHtml, { USE_PROFILES: { html: true } }) : ''), [email]);
  const canCancel = email && (email.campaign.status === 'SCHEDULED' || email.campaign.status === 'RUNNING') && email.status === 'SCHEDULED';

  const cancelCampaign = async () => {
    if (!email) return;
    setCancelling(true);
    try {
      const result = await campaignsApi.cancel(email.campaign.id);
      toast.show(`Campaign cancelled: ${result.cancelledEmails} unsent email(s) stopped.`, 'success');
      setConfirmCancel(false);
      counts.refresh();
      reload();
    } catch (err) {
      toast.show(errorMessage(err), 'error');
    } finally {
      setCancelling(false);
    }
  };

  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/scheduled'));

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <IconButton label="Back" onClick={back}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold text-ink">
          {email ? email.subject : loading ? 'Loading…' : 'Email'}
          {email && <span className="ml-2 align-middle text-[12px] font-normal text-faint">#{email.id.slice(0, 8).toUpperCase()}</span>}
        </h1>
        {email && <StatusPill status={email.status} scheduledAt={email.scheduledAt} />}
        <UserChip compact />
      </header>

      {loading && !email ? (
        <ListSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : email ? (
        <div className="mx-auto w-full max-w-[860px] px-4 py-6 md:px-8">
          <div className="flex items-start gap-3">
            <Avatar name={email.sender.displayName ?? email.sender.email} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate">
                <span className="font-semibold text-ink">{email.sender.displayName ?? email.sender.email}</span>
                {email.sender.displayName && <span className="text-muted"> &lt;{email.sender.email}&gt;</span>}
              </p>
              <p className="truncate text-[12px] text-muted">to {email.recipientEmail}</p>
            </div>
            <time className="shrink-0 text-[12px] text-muted" dateTime={email.sentAt ?? email.scheduledAt}>
              {formatDateTime(email.sentAt ?? email.scheduledAt)}
            </time>
          </div>

          <div className="mt-4 space-y-3 md:pl-12">
            <DeliveryNote email={email} />
            <div className="email-content text-[14px] leading-relaxed text-ink" dangerouslySetInnerHTML={{ __html: safeBody }} />
          </div>

          <dl className="mt-8 rounded-xl border border-line px-4 py-3 text-[12px] md:ml-12">
            <Meta label="Status">
              <StatusPill status={email.status} scheduledAt={email.scheduledAt} />
            </Meta>
            <Meta label="Scheduled for">{formatDateTime(email.scheduledAt)}</Meta>
            {email.rescheduleCount > 0 && (
              <Meta label="Originally scheduled">
                {formatDateTime(email.originalScheduledAt)} (moved {email.rescheduleCount}× by the hourly limit)
              </Meta>
            )}
            {email.sentAt && <Meta label="Sent at">{formatDateTime(email.sentAt)}</Meta>}
            <Meta label="Campaign">{email.campaign.subject}</Meta>
            {email.previewUrl && (
              <Meta label="Ethereal preview">
                <a href={email.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-strong hover:underline">
                  Open message <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              </Meta>
            )}
            {email.providerMessageId && <Meta label="Message id">{email.providerMessageId}</Meta>}
          </dl>

          {canCancel && (
            <div className="mt-4 md:ml-12">
              <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirmCancel(true)}>
                Cancel this campaign
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel campaign?"
        description="All emails of this campaign that have not been sent yet will be cancelled. Emails already sent stay sent."
        confirmLabel="Cancel campaign"
        busy={cancelling}
        onConfirm={() => void cancelCampaign()}
        onClose={() => setConfirmCancel(false)}
      />
    </div>
  );
}
