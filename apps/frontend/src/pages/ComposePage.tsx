import { useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { ArrowLeft, Clock, Paperclip, Upload } from 'lucide-react';
import { useNavigate } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { campaignsApi, sendersApi } from '../api/endpoints';
import { RecipientInput } from '../components/compose/RecipientInput';
import { RichTextEditor, type RichTextValue } from '../components/compose/RichTextEditor';
import { SendLaterPopover } from '../components/compose/SendLaterPopover';
import { Button, IconButton } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { useAsync } from '../hooks/useAsync';
import { useMailboxCounts } from '../hooks/useMailboxCounts';
import type { RecipientSummary } from '../types/api';
import { plural } from '../utils/format';
import { addRecipients, validateLeadFile, type RecipientChip } from '../utils/recipients';
import { browserTimeZone } from '../utils/time';

type Field = 'sender' | 'recipients' | 'subject' | 'body' | 'delay' | 'hourlyLimit';
type Errors = Partial<Record<Field, string>>;

export interface ComposeValues {
  senderId: string;
  chips: RecipientChip[];
  subject: string;
  body: RichTextValue;
  delay: string;
  hourlyLimit: string;
}

// Client-side checks (the backend validates everything again).
export function validateCompose(v: ComposeValues): Errors {
  const errors: Errors = {};
  if (!v.senderId) errors.sender = 'Choose a sender';
  const valid = v.chips.filter((c) => c.valid).length;
  const invalid = v.chips.length - valid;
  if (invalid) errors.recipients = `Remove ${plural(invalid, 'invalid address')} before scheduling`;
  else if (!valid) errors.recipients = 'Add at least one recipient';
  if (!v.subject.trim()) errors.subject = 'Subject is required';
  if (!v.body.text.trim()) errors.body = 'Write the email body';
  if (v.delay.trim() && !/^\d+$/.test(v.delay.trim())) errors.delay = 'Whole seconds (0–3600)';
  else if (Number(v.delay || 0) > 3600) errors.delay = 'At most 3600 seconds';
  if (v.hourlyLimit.trim()) {
    const n = Number(v.hourlyLimit);
    if (!/^\d+$/.test(v.hourlyLimit.trim()) || n < 1 || n > 10_000) errors.hourlyLimit = '1–10,000 emails per hour';
  }
  return errors;
}

const ISSUE_FIELDS: Record<string, Field> = {
  senderId: 'sender',
  recipients: 'recipients',
  recipientsText: 'recipients',
  subject: 'subject',
  body: 'body',
  delayBetweenEmailsSeconds: 'delay',
  hourlyLimit: 'hourlyLimit',
};

function Row({ label, htmlFor, children, error }: { label: string; htmlFor?: string; children: ReactNode; error?: string }) {
  return (
    <div className="border-b border-line">
      <div className="flex min-h-11 min-w-0 items-center gap-4">
        <label htmlFor={htmlFor} className="w-14 shrink-0 text-[12px] text-ink-2">
          {label}
        </label>
        {children}
      </div>
      {error && (
        <p role="alert" className="pb-2 pl-[72px] text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function ComposePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const counts = useMailboxCounts();
  const senders = useAsync((signal) => sendersApi.list(signal), []);
  const activeSenders = useMemo(() => (senders.data ?? []).filter((s) => s.isActive), [senders.data]);

  const [senderId, setSenderId] = useState('');
  const [chips, setChips] = useState<RecipientChip[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState<RichTextValue>({ html: '', text: '' });
  const [delay, setDelay] = useState('');
  const [hourlyLimit, setHourlyLimit] = useState('');
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [errors, setErrors] = useState<Errors>({});
  const [upload, setUpload] = useState<{ name: string; summary: RecipientSummary } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [popover, setPopover] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [creatingSender, setCreatingSender] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // One id per compose session: a double submit or retry cannot create two campaigns.
  const requestId = useRef(crypto.randomUUID());

  const effectiveSender = senderId || activeSenders[0]?.id || '';
  const validCount = chips.filter((c) => c.valid).length;
  const invalidCount = chips.length - validCount;

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const problem = validateLeadFile(file);
    if (problem) {
      toast.show(problem, 'error');
      return;
    }
    setUploading(true);
    try {
      // The server parses the list (authoritative counts, header handling).
      const parsed = await campaignsApi.parseRecipients(await file.text());
      const merged = addRecipients(chips, parsed.emails);
      setChips(merged.chips);
      setUpload({ name: file.name, summary: { ...parsed, duplicatesRemoved: parsed.duplicatesRemoved + merged.duplicates } });
      setErrors((x) => ({ ...x, recipients: undefined }));
      if (parsed.tooMany) toast.show('The list has more than 10,000 addresses; only the first 10,000 were added.', 'error');
    } catch (err) {
      toast.show(errorMessage(err), 'error');
    } finally {
      setUploading(false);
    }
  };

  const createEthereal = async () => {
    setCreatingSender(true);
    try {
      const sender = await sendersApi.createEthereal(100);
      setSenderId(sender.id);
      senders.reload();
      toast.show(`Ethereal sender ${sender.email} created`, 'success');
    } catch (err) {
      toast.show(errorMessage(err), 'error');
    } finally {
      setCreatingSender(false);
    }
  };

  const openScheduler = () => {
    const found = validateCompose({ senderId: effectiveSender, chips, subject, body, delay, hourlyLimit });
    setErrors(found);
    if (Object.keys(found).length) {
      toast.show('Please fix the highlighted fields', 'error');
      return;
    }
    setPopover(true);
  };

  const schedule = async (start: Date) => {
    setSubmitting(true);
    try {
      const result = await campaignsApi.create({
        senderId: effectiveSender,
        subject: subject.trim(),
        body: body.html,
        recipients: chips.filter((c) => c.valid).map((c) => c.value),
        startAt: start.toISOString(),
        timezone: timeZone,
        delayBetweenEmailsSeconds: Number(delay || 0),
        ...(hourlyLimit.trim() ? { hourlyLimit: Number(hourlyLimit) } : {}),
        clientRequestId: requestId.current,
      });
      const n = result.campaign.totalEmails;
      toast.show(
        result.pendingReconciliation > 0
          ? `Saved ${plural(n, 'email')}; ${result.pendingReconciliation} will be queued automatically when the worker reconnects.`
          : `Scheduled ${plural(n, 'email')}.`,
        'success',
      );
      counts.refresh();
      // The search index catches up within seconds; the list refreshes itself once or twice.
      navigate('/scheduled', { state: { justScheduled: n } });
    } catch (err) {
      setPopover(false);
      if (err instanceof ApiError) {
        const next: Errors = {};
        for (const issue of err.issues) {
          const field = ISSUE_FIELDS[issue.path.split('.')[0] ?? ''];
          if (field) next[field] = issue.message;
        }
        if (err.code === 'invalid_recipients') next.recipients = err.message;
        if (err.code === 'empty_body') next.body = err.message;
        if (err.code === 'sender_inactive' || err.status === 404) next.sender = err.message;
        setErrors(next);
      }
      toast.show(errorMessage(err), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 px-4 py-3">
        <IconButton label="Back" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <h1 className="flex-1 text-[16px] font-semibold text-ink">Compose New Email</h1>
        <div className="relative flex items-center gap-1">
          <IconButton label="Upload list" onClick={() => fileRef.current?.click()} className="text-brand-strong">
            <Paperclip className="size-4" />
          </IconButton>
          <IconButton label="Send later" onClick={openScheduler} className="text-brand-strong">
            <Clock className="size-4" />
          </IconButton>
          <Button variant="outline" pill size="sm" onClick={openScheduler} loading={submitting}>
            Send Later
          </Button>
          {popover && (
            <SendLaterPopover
              timeZone={timeZone}
              onTimeZoneChange={setTimeZone}
              busy={submitting}
              onConfirm={(start) => void schedule(start)}
              onClose={() => setPopover(false)}
            />
          )}
        </div>
      </header>

      <div className="mx-auto w-full max-w-[900px] flex-1 px-4 pb-10 md:px-16">
        <Row label="From" htmlFor="compose-from" error={errors.sender}>
          {senders.loading && !senders.data ? (
            <Spinner className="size-4 text-muted" label="Loading senders" />
          ) : activeSenders.length ? (
            <select
              id="compose-from"
              value={effectiveSender}
              onChange={(e) => setSenderId(e.target.value)}
              className="h-8 w-full min-w-0 truncate rounded-lg bg-field px-2.5 text-[13px] text-ink focus:ring-2 focus:ring-brand/30 focus:outline-none sm:w-auto sm:max-w-full"
            >
              {activeSenders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName ? `${s.displayName} <${s.email}>` : s.email} · {s.hourlyLimit}/h
                </option>
              ))}
            </select>
          ) : (
            <span className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
              {senders.error ? senders.error : 'You have no active sender yet.'}
              <Button variant="outline" pill size="sm" loading={creatingSender} onClick={() => void createEthereal()}>
                Create Ethereal sender
              </Button>
              <button type="button" className="text-brand-strong hover:underline" onClick={() => navigate('/settings')}>
                Add SMTP sender
              </button>
            </span>
          )}
        </Row>

        <Row label="To" error={errors.recipients}>
          <RecipientInput
            chips={chips}
            invalid={!!errors.recipients}
            onChange={(next) => {
              setChips(next);
              setErrors((x) => ({ ...x, recipients: undefined }));
            }}
            onDuplicates={(n) => toast.show(`${plural(n, 'duplicate address')} skipped`)}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-brand-strong hover:underline disabled:opacity-50"
          >
            {uploading ? <Spinner className="size-3.5" /> : <Upload className="size-3.5" aria-hidden="true" />}
            Upload List
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" onChange={(e) => void onFile(e)} aria-label="Upload lead list" />
        </Row>

        {(chips.length > 0 || upload) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2 pl-[72px] text-[12px] text-muted" aria-live="polite">
            <span className="font-medium text-ink">{plural(validCount, 'recipient')}</span>
            {invalidCount > 0 && <span className="text-danger">{plural(invalidCount, 'invalid address')} (not sent)</span>}
            {upload && (
              <>
                <span>
                  {upload.name}: {plural(upload.summary.valid, 'email')} detected
                </span>
                {upload.summary.invalid > 0 && (
                  <details className="text-danger">
                    <summary className="cursor-pointer">{plural(upload.summary.invalid, 'invalid row')} skipped</summary>
                    <ul className="mt-1 max-h-28 overflow-auto text-[11px]">
                      {upload.summary.invalidEntries.map((e) => (
                        <li key={`${e.row}-${e.value}`}>
                          Row {e.row}: {e.value}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {upload.summary.duplicatesRemoved > 0 && <span>{plural(upload.summary.duplicatesRemoved, 'duplicate')} removed</span>}
              </>
            )}
          </div>
        )}

        <Row label="Subject" htmlFor="compose-subject" error={errors.subject}>
          <input
            id="compose-subject"
            value={subject}
            maxLength={300}
            onChange={(e) => {
              setSubject(e.target.value);
              setErrors((x) => ({ ...x, subject: undefined }));
            }}
            placeholder="Subject"
            className="h-9 flex-1 bg-transparent text-[13px] text-ink placeholder:text-faint focus:outline-none"
          />
        </Row>

        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 py-3">
          <label className="flex items-center gap-3 text-[12px] text-ink-2">
            Delay between 2 emails
            <span className="flex items-center gap-1.5">
              <input
                inputMode="numeric"
                value={delay}
                onChange={(e) => setDelay(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                placeholder="00"
                aria-describedby="delay-help"
                aria-invalid={!!errors.delay}
                className={`h-8 w-14 rounded-lg border px-2 text-center text-[13px] text-ink placeholder:text-faint focus:ring-2 focus:ring-brand/30 focus:outline-none ${errors.delay ? 'border-danger' : 'border-line'}`}
              />
              <span id="delay-help" className="text-muted">
                sec
              </span>
            </span>
          </label>
          <label className="flex items-center gap-3 text-[12px] text-ink-2">
            Hourly Limit
            <span className="flex items-center gap-1.5">
              <input
                inputMode="numeric"
                value={hourlyLimit}
                onChange={(e) => setHourlyLimit(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
                placeholder="00"
                aria-describedby="limit-help"
                aria-invalid={!!errors.hourlyLimit}
                className={`h-8 w-16 rounded-lg border px-2 text-center text-[13px] text-ink placeholder:text-faint focus:ring-2 focus:ring-brand/30 focus:outline-none ${errors.hourlyLimit ? 'border-danger' : 'border-line'}`}
              />
              <span id="limit-help" className="text-muted">
                emails / hour
              </span>
            </span>
          </label>
          {(errors.delay || errors.hourlyLimit) && (
            <p role="alert" className="w-full text-[12px] text-danger">
              {[errors.delay && `Delay: ${errors.delay}`, errors.hourlyLimit && `Hourly limit: ${errors.hourlyLimit}`].filter(Boolean).join(' · ')}
            </p>
          )}
          <p className="w-full text-[11px] text-muted">
            Leave the hourly limit empty to use the sender&apos;s limit. Emails over the limit move to the next hour automatically.
          </p>
        </div>

        <RichTextEditor
          invalid={!!errors.body}
          onChange={(v) => {
            setBody(v);
            setErrors((x) => ({ ...x, body: undefined }));
          }}
        />
        {errors.body && (
          <p role="alert" className="mt-1.5 text-[12px] text-danger">
            {errors.body}
          </p>
        )}
      </div>
    </div>
  );
}
