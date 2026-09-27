import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RecipientChip } from '../../utils/recipients';
import { RecipientInput } from './RecipientInput';

function Harness({ onDuplicates }: { onDuplicates?: (n: number) => void }) {
  const [chips, setChips] = useState<RecipientChip[]>([]);
  return (
    <>
      <RecipientInput chips={chips} onChange={setChips} onDuplicates={onDuplicates} />
      <output data-testid="chips">{chips.map((c) => `${c.value}:${c.valid ? 'ok' : 'bad'}`).join(',')}</output>
    </>
  );
}

describe('RecipientInput', () => {
  it('turns typed addresses into chips on Enter/comma and flags invalid ones', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText('Recipients');
    await user.type(input, 'Jane@Acme.io{Enter}broken,');
    expect(screen.getByTestId('chips')).toHaveTextContent('jane@acme.io:ok,broken:bad');
    expect(screen.getByTitle('broken is not a valid email address')).toBeInTheDocument();
  });

  it('commits addresses that arrive without key events (autofill/IME) and keeps the partial one', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Recipients');
    fireEvent.change(input, { target: { value: 'one@x.com, two@x.com; thr' } });
    expect(screen.getByTestId('chips')).toHaveTextContent('one@x.com:ok,two@x.com:ok');
    expect(input).toHaveValue('thr');
  });

  it('accepts a pasted list, skips duplicates, collapses to +N and removes chips', async () => {
    const user = userEvent.setup();
    const onDuplicates = vi.fn();
    render(<Harness onDuplicates={onDuplicates} />);
    const input = screen.getByLabelText('Recipients');
    await user.click(input);
    await user.paste('a@x.com, b@x.com; c@x.com\nd@x.com a@x.com');
    expect(screen.getByTestId('chips')).toHaveTextContent('a@x.com:ok,b@x.com:ok,c@x.com:ok,d@x.com:ok');
    expect(onDuplicates).toHaveBeenCalledWith(1);
    expect(screen.getByRole('button', { name: '+1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove b@x.com' }));
    expect(screen.getByTestId('chips')).toHaveTextContent('a@x.com:ok,c@x.com:ok,d@x.com:ok');
    await user.click(input);
    await user.keyboard('{Backspace}');
    expect(screen.getByTestId('chips')).toHaveTextContent('a@x.com:ok,c@x.com:ok');
  });
});
