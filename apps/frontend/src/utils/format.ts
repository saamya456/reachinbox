// Display formatting (always in the viewer's own time zone).

const pillFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const shortFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// "Tue 9:15:12 AM" (the Figma's scheduled pill).
export const formatPillTime = (iso: string) => pillFormat.format(new Date(iso));
// "Nov 3, 2026, 10:23 AM"
export const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));
// "Nov 3, 10:23 AM"
export const formatShort = (iso: string) => shortFormat.format(new Date(iso));

export function initials(nameOrEmail: string | null | undefined): string {
  const source = (nameOrEmail ?? '?').trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}
