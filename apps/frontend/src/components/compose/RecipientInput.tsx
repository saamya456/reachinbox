import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { addRecipients, tokenizeRecipients, type RecipientChip } from '../../utils/recipients';

const COLLAPSED_VISIBLE = 3;

// "To" field with recipient chips (Figma: green outlined pills, "+N" overflow).
// Typing a separator (Enter, comma, semicolon, space, Tab) or pasting a list
// turns text into chips; invalid addresses are shown in red and never sent.
export function RecipientInput({
  chips,
  onChange,
  onDuplicates,
  invalid = false,
}: {
  chips: RecipientChip[];
  onChange: (chips: RecipientChip[]) => void;
  onDuplicates?: (count: number) => void;
  invalid?: boolean;
}) {
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addTokens = (raw: string) => {
    const tokens = tokenizeRecipients(raw);
    if (!tokens.length) return;
    const result = addRecipients(chips, tokens);
    onChange(result.chips);
    if (result.duplicates) onDuplicates?.(result.duplicates);
  };

  const commit = (raw: string) => {
    addTokens(raw);
    setText('');
  };

  // Text can arrive without key events (autofill, IME, drag-and-drop): commit
  // every complete address in it and keep a trailing partial one in the box.
  const onTextChange = (value: string) => {
    const lastSeparator = value.search(/[\s,;][^\s,;]*$/);
    if (lastSeparator === -1) {
      setText(value);
      return;
    }
    addTokens(value.slice(0, lastSeparator + 1));
    setText(value.slice(lastSeparator + 1));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ';', ' ', 'Tab'].includes(e.key) && text.trim()) {
      e.preventDefault();
      commit(text);
    } else if (e.key === 'Backspace' && !text && chips.length) {
      onChange(chips.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (/[\s,;]/.test(pasted)) {
      e.preventDefault();
      commit(text + pasted);
    }
  };

  const visible = expanded ? chips : chips.slice(0, COLLAPSED_VISIBLE);
  const hidden = chips.length - visible.length;

  return (
    <div
      className="flex min-h-9 flex-1 flex-wrap items-center gap-1.5 py-1"
      onClick={() => inputRef.current?.focus()}
      aria-invalid={invalid || undefined}
    >
      {visible.map((chip) => (
        <span
          key={chip.value}
          title={chip.valid ? chip.value : `${chip.value} is not a valid email address`}
          className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] ${
            chip.valid ? 'border-brand-line bg-white text-ink-2' : 'border-danger/40 bg-danger-soft text-danger'
          }`}
        >
          {chip.value}
          <button
            type="button"
            aria-label={`Remove ${chip.value}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange(chips.filter((c) => c.value !== chip.value));
            }}
            className="text-faint hover:text-ink"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          className="inline-flex h-6 items-center rounded-full border border-brand-line bg-brand-soft px-2 text-[12px] font-medium text-brand-strong"
        >
          +{hidden.toLocaleString()}
        </button>
      )}
      {expanded && chips.length > COLLAPSED_VISIBLE && (
        <button type="button" onClick={() => setExpanded(false)} className="text-[12px] text-muted hover:text-ink">
          Show less
        </button>
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="email"
        aria-label="Recipients"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => commit(text)}
        placeholder={chips.length ? '' : 'recipient@example.com'}
        className="h-7 min-w-[180px] flex-1 bg-transparent text-[13px] text-ink placeholder:text-faint focus:outline-none"
      />
    </div>
  );
}
