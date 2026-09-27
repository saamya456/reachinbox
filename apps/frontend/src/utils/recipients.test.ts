import { describe, expect, it } from 'vitest';
import { addRecipients, isValidEmail, tokenizeRecipients, validateLeadFile } from './recipients';

describe('recipient helpers', () => {
  it('tokenizes pasted text on commas, semicolons, spaces and newlines', () => {
    expect(tokenizeRecipients('a@x.com, B@Y.org;c@z.io\n <d@w.co>  mailto:e@v.io')).toEqual([
      'a@x.com',
      'b@y.org',
      'c@z.io',
      'd@w.co',
      'e@v.io',
    ]);
  });

  it('validates addresses', () => {
    expect(isValidEmail('jane.doe+tag@acme.io')).toBe(true);
    for (const bad of ['jane@', '@acme.io', 'jane@@acme.io', 'jane@localhost', 'jane acme.io', 'jane@acme']) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it('adds chips, flags invalid ones and skips duplicates', () => {
    const first = addRecipients([], ['a@x.com', 'bad', 'a@x.com']);
    expect(first.chips).toEqual([
      { value: 'a@x.com', valid: true },
      { value: 'bad', valid: false },
    ]);
    expect(first.duplicates).toBe(1);
    expect(addRecipients(first.chips, ['a@x.com', 'b@x.com']).duplicates).toBe(1);
  });

  it('accepts only small .csv/.txt lead files', () => {
    const file = (name: string, size: number) => new File(['x'.repeat(size)], name);
    expect(validateLeadFile(file('leads.csv', 10))).toBeNull();
    expect(validateLeadFile(file('leads.TXT', 10))).toBeNull();
    expect(validateLeadFile(file('leads.xlsx', 10))).toMatch(/csv or \.txt/);
    expect(validateLeadFile(file('leads.csv', 0))).toMatch(/empty/);
    expect(validateLeadFile(file('big.csv', 2 * 1024 * 1024 + 1))).toMatch(/2 MB/);
  });
});
