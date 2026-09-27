import { TZDate } from '@date-fns/tz';

// Scheduling time handling. The user picks a wall-clock date/time in a chosen
// IANA time zone; the backend receives an absolute ISO instant (UTC). DST is
// handled by @date-fns/tz: times that do not exist (spring-forward gap) are
// rejected, ambiguous times (fall-back) resolve to the first occurrence.

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// IANA zones for the picker. Intl.supportedValuesOf('timeZone') lists region
// zones only (no "UTC"), and the browser's own zone may be a legacy alias
// (e.g. "Asia/Calcutta") missing from it, so both are added explicitly.
export function allTimeZones(): string[] {
  const zones = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  const list = zones.filter((z) => z !== 'UTC');
  const current = browserTimeZone();
  const pinned = current === 'UTC' ? ['UTC'] : [current, 'UTC'];
  return [...pinned, ...list.filter((z) => z !== current)];
}

export type LocalDateTime = `${number}-${number}-${number}T${number}:${number}`;

export class ScheduleTimeError extends Error {
  constructor(
    readonly code: 'invalid' | 'nonexistent' | 'past',
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleTimeError';
  }
}

// "2026-10-01T09:30" in `timeZone` -> Date (absolute instant).
export function zonedToInstant(local: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new ScheduleTimeError('invalid', 'Pick a valid date and time');
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number];
  const instant = new TZDate(y, mo - 1, d, h, mi, 0, timeZone);
  if (Number.isNaN(instant.getTime())) throw new ScheduleTimeError('invalid', 'Pick a valid date and time');
  // A wall-clock time skipped by a DST change comes back shifted: reject it.
  if (formatLocalInput(instant, timeZone) !== local) {
    throw new ScheduleTimeError('nonexistent', 'That time does not exist in this time zone (daylight saving change)');
  }
  return new Date(instant.getTime());
}

// Date -> "YYYY-MM-DDTHH:mm" as seen in `timeZone` (for <input type="datetime-local">).
export function formatLocalInput(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// Validates a chosen start: allows "now-ish" (up to 1 minute ago), not the past.
export function resolveStart(local: string, timeZone: string, now = new Date()): Date {
  const instant = zonedToInstant(local, timeZone);
  if (instant.getTime() < now.getTime() - 60_000) throw new ScheduleTimeError('past', 'The start time is in the past');
  return instant;
}

// "Tomorrow, 10:00 AM" style presets in the chosen zone.
export function tomorrowAt(hour: number, timeZone: string, now = new Date()): string {
  const today = formatLocalInput(now, timeZone).slice(0, 10);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const date = next.toISOString().slice(0, 10);
  return `${date}T${String(hour).padStart(2, '0')}:00`;
}
