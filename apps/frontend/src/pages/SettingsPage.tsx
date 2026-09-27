import { useState, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, MessageSquareText, Plus } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { errorMessage } from '../api/client';
import { sendersApi, slackApi } from '../api/endpoints';
import { UserChip } from '../components/layout/UserChip';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorState, ListSkeleton } from '../components/ui/States';
import { useToast } from '../components/ui/Toast';
import { useAsync } from '../hooks/useAsync';
import type { CreateSenderRequest, Sender } from '../types/api';
import { formatDateTime } from '../utils/format';

function Card({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-[12px] text-muted">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const SLACK_RESULTS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Slack connected.' },
  denied: { ok: false, text: 'Slack connection was cancelled.' },
  invalid_state: { ok: false, text: 'The Slack connection link expired or belongs to another session. Please try again.' },
  not_configured: { ok: false, text: 'Slack is not configured on this server.' },
  error: { ok: false, text: 'Slack connection failed. Please try again.' },
  invalid_request: { ok: false, text: 'Slack returned an incomplete response. Please try again.' },
};

function SlackCard() {
  const toast = useToast();
  const [params] = useSearchParams();
  const status = useAsync((signal) => slackApi.status(signal), []);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const result = SLACK_RESULTS[params.get('slack') ?? ''];

  const disconnect = async () => {
    setBusy(true);
    try {
      const r = await slackApi.disconnect();
      toast.show(r.revoked ? 'Slack disconnected.' : 'Slack disconnected here; Slack did not confirm the token revocation.', 'success');
      setConfirm(false);
      status.reload();
    } catch (err) {
      toast.show(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const s = status.data;
  return (
    <Card title="Slack notifications" description="Get a Slack message the moment a sender or campaign hits its hourly limit.">
      {result && (
        <p role="status" className={`mb-3 rounded-lg px-3 py-2 text-[12px] ${result.ok ? 'bg-brand-soft text-brand-strong' : 'bg-danger-soft text-danger'}`}>
          {result.text}
        </p>
      )}
      {status.loading && !s ? (
        <ListSkeleton rows={1} />
      ) : status.error ? (
        <ErrorState message={status.error} onRetry={status.reload} />
      ) : s ? (
        <div className="flex flex-wrap items-center gap-3">
          <MessageSquareText className="size-5 text-ink-2" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            {s.status === 'connected' ? (
              <>
                <p className="flex items-center gap-1.5 font-medium text-ink">
                  <CheckCircle2 className="size-4 text-brand" aria-hidden="true" /> Connected to {s.teamName ?? 'Slack'}
                </p>
                <p className="text-[12px] text-muted">
                  Channel {s.channelName ?? '—'}
                  {s.lastNotifiedAt ? ` · last notification ${formatDateTime(s.lastNotifiedAt)}` : ''}
                </p>
              </>
            ) : s.status === 'disconnected' ? (
              <p className="text-ink-2">Not connected</p>
            ) : (
              <>
                <p className="font-medium text-danger">{s.status === 'revoked' ? 'Access was revoked in Slack' : 'Slack reported an error'}</p>
                <p className="text-[12px] text-muted">Reconnect to resume notifications{s.lastError ? ` (${s.lastError})` : ''}.</p>
              </>
            )}
          </div>
          {s.status === 'connected' ? (
            <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirm(true)}>
              Disconnect Slack
            </Button>
          ) : (
            <a
              href={s.configured ? slackApi.connectUrl('/settings') : undefined}
              aria-disabled={!s.configured}
              className={`inline-flex h-8 items-center rounded-full border px-3 text-[12px] font-medium ${
                s.configured ? 'border-brand text-brand-strong hover:bg-brand-soft' : 'cursor-not-allowed border-line text-faint'
              }`}
              title={s.configured ? undefined : 'Slack credentials are not configured on the server'}
            >
              {s.status === 'disconnected' ? 'Connect Slack' : 'Reconnect Slack'}
            </a>
          )}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title="Disconnect Slack?"
        description="Hourly-limit notifications stop, and the stored Slack credentials are deleted. You can reconnect at any time."
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={() => void disconnect()}
        onClose={() => setConfirm(false)}
      />
    </Card>
  );
}

const EMPTY_SENDER: CreateSenderRequest = {
  email: '',
  displayName: '',
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpPassword: '',
  hourlyLimit: 100,
};

function SendersCard() {
  const toast = useToast();
  const senders = useAsync((signal) => sendersApi.list(signal), []);
  const [form, setForm] = useState<CreateSenderRequest | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Sender | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const addEthereal = async () => {
    setCreating(true);
    try {
      const s = await sendersApi.createEthereal(100);
      toast.show(`Ethereal sender ${s.email} created`, 'success');
      senders.reload();
    } catch (err) {
      toast.show(errorMessage(err), 'error');
    } finally {
      setCreating(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    try {
      await sendersApi.create({ ...form, displayName: form.displayName || undefined });
      toast.show('Sender added', 'success');
      setForm(null);
      senders.reload();
    } catch (err) {
      toast.show(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (s: Sender) => {
    setBusyId(s.id);
    try {
      await sendersApi.update(s.id, { isActive: !s.isActive });
      senders.reload();
    } catch (err) {
      toast.show(errorMessage(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusyId(removing.id);
    try {
      const r = await sendersApi.remove(removing.id);
      toast.show(r.outcome === 'deleted' ? 'Sender deleted' : 'Sender has email history, so it was deactivated instead', 'success');
      setRemoving(null);
      senders.reload();
    } catch (err) {
      toast.show(errorMessage(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const input = 'h-8 w-full rounded-lg border border-line px-2.5 text-[13px] focus:ring-2 focus:ring-brand/30 focus:outline-none';
  return (
    <Card title="Senders" description="SMTP accounts your campaigns send from. Passwords are encrypted on the server and never shown again.">
      {senders.loading && !senders.data ? (
        <ListSkeleton rows={2} />
      ) : senders.error ? (
        <ErrorState message={senders.error} onRetry={senders.reload} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {(senders.data ?? []).length === 0 && <li className="px-4 py-6 text-center text-muted">No senders yet.</li>}
          {(senders.data ?? []).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink">
                  {s.displayName ? `${s.displayName} · ` : ''}
                  {s.email}
                </p>
                <p className="text-[12px] text-muted">
                  {s.smtpHost}:{s.smtpPort} · {s.hourlyLimit}/hour {s.isActive ? '' : '· inactive'}
                </p>
              </div>
              <Button variant="ghost" size="sm" loading={busyId === s.id} onClick={() => void toggle(s)}>
                {s.isActive ? 'Deactivate' : 'Activate'}
              </Button>
              <Button variant="ghost" size="sm" className="text-danger" onClick={() => setRemoving(s)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" pill size="sm" loading={creating} icon={<Plus className="size-3.5" />} onClick={() => void addEthereal()}>
          New Ethereal sender
        </Button>
        {!form && (
          <Button variant="ghost" size="sm" onClick={() => setForm(EMPTY_SENDER)}>
            Add SMTP sender
          </Button>
        )}
      </div>

      {form && (
        <form onSubmit={(e) => void submit(e)} className="mt-4 grid gap-3 rounded-xl bg-panel p-4 sm:grid-cols-2">
          {(
            [
              ['email', 'From address', 'email'],
              ['displayName', 'Display name (optional)', 'text'],
              ['smtpHost', 'SMTP host', 'text'],
              ['smtpUser', 'SMTP username', 'text'],
              ['smtpPassword', 'SMTP password', 'password'],
            ] as const
          ).map(([key, label, type]) => (
            <label key={key} className="text-[12px] text-ink-2">
              {label}
              <input
                type={type}
                required={key !== 'displayName'}
                autoComplete={type === 'password' ? 'new-password' : 'off'}
                value={form[key] ?? ''}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className={`mt-1 ${input}`}
              />
            </label>
          ))}
          <label className="text-[12px] text-ink-2">
            Port
            <select value={form.smtpPort} onChange={(e) => setForm({ ...form, smtpPort: Number(e.target.value) })} className={`mt-1 ${input} bg-white`}>
              {[587, 465, 25, 2525].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] text-ink-2">
            Hourly limit
            <input
              type="number"
              min={1}
              max={10000}
              required
              value={form.hourlyLimit}
              onChange={(e) => setForm({ ...form, hourlyLimit: Number(e.target.value) })}
              className={`mt-1 ${input}`}
            />
          </label>
          <label className="flex items-center gap-2 self-end pb-1.5 text-[12px] text-ink-2">
            <input type="checkbox" checked={form.smtpSecure} onChange={(e) => setForm({ ...form, smtpSecure: e.target.checked })} className="accent-[var(--color-brand)]" />
            Implicit TLS (port 465)
          </label>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="ghost" size="sm" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              Save sender
            </Button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={!!removing}
        title="Delete sender?"
        description={`${removing?.email ?? ''} will be deleted. If it has sent or scheduled emails it is deactivated instead, and its scheduled emails will fail when due.`}
        confirmLabel="Delete"
        busy={!!busyId}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}

export function SettingsPage() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h1 className="flex-1 text-[16px] font-semibold text-ink">Settings</h1>
        <UserChip />
      </header>
      <div className="mx-auto grid w-full max-w-[760px] gap-4 px-4 py-6">
        <SendersCard />
        <SlackCard />
      </div>
    </div>
  );
}
