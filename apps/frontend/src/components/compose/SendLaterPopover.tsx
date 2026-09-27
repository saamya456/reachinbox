import { useEffect, useMemo, useRef, useState } from 'react';
import { allTimeZones, formatLocalInput, resolveStart, ScheduleTimeError, tomorrowAt } from '../../utils/time';
import { Button } from '../ui/Button';

// "Send Later" popover from the Figma: date/time picker, quick picks,
// Cancel / Done. Adds the time zone selector the assignment needs; the chosen
// wall-clock time is converted to an absolute instant for the backend.
export function SendLaterPopover({
  timeZone,
  onTimeZoneChange,
  busy,
  onConfirm,
  onClose,
}: {
  timeZone: string;
  onTimeZoneChange: (tz: string) => void;
  busy: boolean;
  onConfirm: (start: Date) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const zones = useMemo(allTimeZones, []);
  const min = formatLocalInput(new Date(), timeZone);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    const onClick = (e: MouseEvent) => !busy && !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [busy, onClose]);

  const presets: { label: string; value: string }[] = [
    { label: 'Tomorrow, 10:00 AM', value: tomorrowAt(10, timeZone) },
    { label: 'Tomorrow, 11:00 AM', value: tomorrowAt(11, timeZone) },
    { label: 'Tomorrow, 3:00 PM', value: tomorrowAt(15, timeZone) },
  ];

  const done = (local: string) => {
    try {
      onConfirm(resolveStart(local, timeZone));
      setError(null);
    } catch (err) {
      setError(err instanceof ScheduleTimeError ? err.message : 'Pick a valid date and time');
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Send later"
      className="absolute top-full right-0 z-30 mt-2 w-[300px] rounded-xl border border-line bg-white p-4 shadow-xl"
    >
      <p className="text-[13px] font-semibold text-ink">Send Later</p>

      <label className="mt-3 block">
        <span className="sr-only">Pick date &amp; time</span>
        <span className="relative flex items-center">
          <input
            type="datetime-local"
            value={value}
            min={min}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            className="h-9 w-full rounded-lg border border-line px-3 text-[12px] text-ink focus:ring-2 focus:ring-brand/30 focus:outline-none"
            aria-describedby={error ? 'send-later-error' : undefined}
          />
        </span>
      </label>

      <label className="mt-2 block">
        <span className="text-[11px] text-muted">Time zone</span>
        <select
          value={timeZone}
          onChange={(e) => onTimeZoneChange(e.target.value)}
          className="mt-1 h-8 w-full rounded-lg border border-line bg-white px-2 text-[12px] text-ink-2 focus:outline-none"
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-3 flex flex-col">
        {/* The exact current instant: the picker's format only has minutes, and
            a minute-truncated "now" can already be seconds too far in the past. */}
        <button type="button" onClick={() => onConfirm(new Date())} disabled={busy} className="rounded-md px-1 py-1.5 text-left text-[12px] text-ink-2 hover:bg-field">
          Now
        </button>
        <p className="px-1 pt-1.5 pb-0.5 text-[11px] text-muted">Tomorrow</p>
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setValue(p.value);
              setError(null);
            }}
            className={`rounded-md px-1 py-1.5 text-left text-[12px] hover:bg-field ${value === p.value ? 'font-medium text-brand-strong' : 'text-ink-2'}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && (
        <p id="send-later-error" role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-3">
        <button type="button" onClick={onClose} disabled={busy} className="text-[12px] font-medium text-ink-2 hover:text-ink">
          Cancel
        </button>
        <Button variant="outline" pill size="sm" loading={busy} disabled={!value} onClick={() => done(value)}>
          Done
        </Button>
      </div>
    </div>
  );
}
