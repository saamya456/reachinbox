import { z } from 'zod';

// Lead list parsing (the single authoritative parser; the browser only
// pre-validates). Accepts:
//  - newline-, comma-, semicolon- or whitespace-separated addresses;
//  - CSV/TSV content, with or without a header row. A header with an
//    "email" column restricts extraction to that column; otherwise every cell
//    containing "@" is a candidate.
// Addresses are trimmed, unwrapped ("<a@b.c>", "mailto:"), lower-cased,
// validated and de-duplicated keeping the first occurrence, so the order is
// deterministic. Invalid entries are reported, never silently dropped.

export const RECIPIENT_LIMITS = {
  maxInputBytes: 2 * 1024 * 1024,
  maxRows: 50_000,
  maxRecipients: 10_000,
  maxReportedInvalid: 100,
} as const;

export interface ParsedRecipients {
  emails: string[];
  total: number;
  valid: number;
  invalid: number;
  duplicatesRemoved: number;
  invalidEntries: { row: number; value: string }[];
}

export class RecipientInputError extends Error {
  constructor(
    readonly code: 'input_too_large' | 'too_many_rows',
    message: string,
  ) {
    super(message);
    this.name = 'RecipientInputError';
  }
}

const emailSchema = z.email().max(254);
const HEADER_EMAIL = /^(e-?mail|email ?address|e-?mail ?id|mail)$/i;

// One CSV line into cells, honoring double quotes ("a, b" stays one cell).
function splitCells(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delimiter && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

function detectDelimiter(sample: string): string {
  const counts = [',', ';', '\t'].map((d) => [d, sample.split(d).length - 1] as const);
  const [best, n] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return n > 0 ? best : ',';
}

function normalize(candidate: string): string {
  return candidate
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^[<"'(]+|[>"')]+$/g, '')
    .trim()
    .toLowerCase();
}

export function parseRecipientText(text: string): ParsedRecipients {
  if (Buffer.byteLength(text, 'utf8') > RECIPIENT_LIMITS.maxInputBytes) {
    throw new RecipientInputError('input_too_large', `Recipient input exceeds ${RECIPIENT_LIMITS.maxInputBytes / 1024 / 1024} MB`);
  }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines.length > RECIPIENT_LIMITS.maxRows) {
    throw new RecipientInputError('too_many_rows', `Recipient input exceeds ${RECIPIENT_LIMITS.maxRows} rows`);
  }

  const firstContent = lines.find((l) => l.trim()) ?? '';
  const delimiter = detectDelimiter(firstContent);
  const seen = new Set<string>();
  const result: ParsedRecipients = { emails: [], total: 0, valid: 0, invalid: 0, duplicatesRemoved: 0, invalidEntries: [] };
  let emailColumn: number | null = null;
  let headerChecked = false;

  const reportInvalid = (row: number, value: string) => {
    result.invalid++;
    if (result.invalidEntries.length < RECIPIENT_LIMITS.maxReportedInvalid) {
      result.invalidEntries.push({ row, value: value.slice(0, 200) });
    }
  };

  lines.forEach((line, index) => {
    const row = index + 1;
    if (!line.trim()) return;
    const cells = splitCells(line, delimiter);

    // Header row: no "@" anywhere. Remember an "email" column if there is one.
    if (!headerChecked) {
      headerChecked = true;
      if (!line.includes('@')) {
        const col = cells.findIndex((c) => HEADER_EMAIL.test(c.replace(/^"|"$/g, '')));
        if (col >= 0) emailColumn = col;
        if (col >= 0 || cells.length > 1) return; // header row (skip)
      }
    }

    const candidates =
      emailColumn !== null
        ? [cells[emailColumn] ?? '']
        : // Free text may mix separators ("a@x.com; b@y.com c@z.com").
          cells.flatMap((c) => c.split(/[\s,;]+/)).filter((c) => c.includes('@'));

    if (candidates.length === 0 || (candidates.length === 1 && !candidates[0])) {
      result.total++;
      reportInvalid(row, line.trim());
      return;
    }
    for (const raw of candidates) {
      result.total++;
      const email = normalize(raw);
      if (!emailSchema.safeParse(email).success) {
        reportInvalid(row, raw);
        continue;
      }
      if (seen.has(email)) {
        result.duplicatesRemoved++;
        continue;
      }
      seen.add(email);
      result.emails.push(email);
    }
  });

  result.valid = result.emails.length;
  return result;
}

// Chips/array input: each entry may itself hold several addresses.
export function parseRecipientList(entries: string[]): ParsedRecipients {
  return parseRecipientText(entries.join('\n'));
}

// Combines separately parsed sources (e.g. typed chips + an uploaded CSV, which
// must be parsed on its own so its header row is recognized), keeping order
// and counting addresses present in both as duplicates.
export function mergeRecipients(...parts: ParsedRecipients[]): ParsedRecipients {
  const merged: ParsedRecipients = { emails: [], total: 0, valid: 0, invalid: 0, duplicatesRemoved: 0, invalidEntries: [] };
  const seen = new Set<string>();
  for (const part of parts) {
    merged.total += part.total;
    merged.invalid += part.invalid;
    merged.duplicatesRemoved += part.duplicatesRemoved;
    merged.invalidEntries.push(...part.invalidEntries);
    for (const email of part.emails) {
      if (seen.has(email)) merged.duplicatesRemoved++;
      else {
        seen.add(email);
        merged.emails.push(email);
      }
    }
  }
  merged.valid = merged.emails.length;
  merged.invalidEntries = merged.invalidEntries.slice(0, RECIPIENT_LIMITS.maxReportedInvalid);
  return merged;
}
