// Client-side recipient handling for the chips input. This is a convenience
// pre-check only: the backend parses and validates every address again and is
// the authority (see apps/backend/src/campaigns/recipients.ts).

// Pragmatic address check mirroring the server's rules closely enough for UX.
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

export function normalizeAddress(raw: string): string {
  return raw
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^[<"'(]+|[>"')]+$/g, '')
    .trim()
    .toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

// Splits pasted/typed text on commas, semicolons, whitespace and newlines.
export function tokenizeRecipients(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map(normalizeAddress)
    .filter(Boolean);
}

export interface RecipientChip {
  value: string;
  valid: boolean;
}

// Adds tokens to the list, skipping duplicates; returns how many were skipped.
export function addRecipients(current: RecipientChip[], tokens: string[]): { chips: RecipientChip[]; duplicates: number } {
  const seen = new Set(current.map((c) => c.value));
  const chips = [...current];
  let duplicates = 0;
  for (const token of tokens) {
    if (seen.has(token)) {
      duplicates++;
      continue;
    }
    seen.add(token);
    chips.push({ value: token, valid: isValidEmail(token) });
  }
  return { chips, duplicates };
}

export const LEAD_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const LEAD_FILE_TYPES = ['.csv', '.txt'];

export function validateLeadFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!LEAD_FILE_TYPES.some((ext) => name.endsWith(ext))) return 'Upload a .csv or .txt file';
  if (file.size > LEAD_FILE_MAX_BYTES) return 'The file is larger than 2 MB';
  if (file.size === 0) return 'The file is empty';
  return null;
}
