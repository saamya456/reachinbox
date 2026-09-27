import type { ReactNode } from 'react';
import TextAlign from '@tiptap/extension-text-align';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';

// Email body editor (TipTap). It produces HTML with basic formatting only;
// the backend sanitizes it again before storing or sending, so nothing the
// browser produces is trusted.

function ToolButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`inline-flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-30 ${
        active ? 'bg-brand-soft text-brand-strong' : 'text-ink-2 hover:bg-field'
      }`}
    >
      {children}
    </button>
  );
}

const Divider = () => <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />;

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      level: ([1, 2, 3] as const).find((l) => e.isActive('heading', { level: l })) ?? 0,
      align: (['center', 'right'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      canSink: e.can().sinkListItem('listItem'),
      canLift: e.can().liftListItem('listItem'),
    }),
  });
  const chain = () => editor.chain().focus();
  const nextAlign = s.align === 'left' ? 'center' : s.align === 'center' ? 'right' : 'left';
  const AlignIcon = s.align === 'center' ? AlignCenter : s.align === 'right' ? AlignRight : AlignLeft;

  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 rounded-lg bg-white px-2 py-1 shadow-[0_0_0_1px_var(--color-line)]">
      <ToolButton label="Undo" disabled={!s.canUndo} onClick={() => chain().undo().run()}>
        <Undo2 className="size-4" />
      </ToolButton>
      <ToolButton label="Redo" disabled={!s.canRedo} onClick={() => chain().redo().run()}>
        <Redo2 className="size-4" />
      </ToolButton>
      <Divider />
      <select
        aria-label="Text size"
        value={s.level}
        onChange={(e) => {
          const level = Number(e.target.value);
          if (level === 0) chain().setParagraph().run();
          else chain().setHeading({ level: level as 1 | 2 | 3 }).run();
        }}
        className="h-7 rounded-md bg-transparent px-1 text-[12px] text-ink-2 hover:bg-field focus:outline-none"
      >
        <option value={0}>Normal</option>
        <option value={1}>Heading 1</option>
        <option value={2}>Heading 2</option>
        <option value={3}>Heading 3</option>
      </select>
      <Divider />
      <ToolButton label="Bold" active={s.bold} onClick={() => chain().toggleBold().run()}>
        <Bold className="size-4" />
      </ToolButton>
      <ToolButton label="Italic" active={s.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic className="size-4" />
      </ToolButton>
      <ToolButton label="Underline" active={s.underline} onClick={() => chain().toggleUnderline().run()}>
        <Underline className="size-4" />
      </ToolButton>
      <Divider />
      <ToolButton label={`Align ${nextAlign}`} active={s.align !== 'left'} onClick={() => chain().setTextAlign(nextAlign).run()}>
        <AlignIcon className="size-4" />
      </ToolButton>
      <Divider />
      <ToolButton label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered className="size-4" />
      </ToolButton>
      <ToolButton label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}>
        <List className="size-4" />
      </ToolButton>
      <ToolButton label="Indent" disabled={!s.canSink} onClick={() => chain().sinkListItem('listItem').run()}>
        <IndentIncrease className="size-4" />
      </ToolButton>
      <ToolButton label="Outdent" disabled={!s.canLift} onClick={() => chain().liftListItem('listItem').run()}>
        <IndentDecrease className="size-4" />
      </ToolButton>
      <ToolButton label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
        <Quote className="size-4" />
      </ToolButton>
      <Divider />
      <ToolButton label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough className="size-4" />
      </ToolButton>
    </div>
  );
}

export interface RichTextValue {
  html: string;
  text: string;
}

export function RichTextEditor({ onChange, invalid = false }: { onChange: (value: RichTextValue) => void; invalid?: boolean }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    editorProps: {
      attributes: {
        'aria-label': 'Email body',
        'aria-multiline': 'true',
        role: 'textbox',
        class: 'email-content min-h-[260px] px-4 py-3 text-[14px] leading-relaxed text-ink',
      },
    },
    onUpdate: ({ editor: e }) => onChange({ html: e.getHTML(), text: e.getText() }),
  });

  const empty = useEditorState({ editor, selector: ({ editor: e }) => e?.isEmpty ?? true });

  return (
    <div className={`rounded-2xl bg-panel p-2 ${invalid ? 'ring-1 ring-danger/50' : ''}`}>
      {editor && <Toolbar editor={editor} />}
      <div className="relative">
        {empty && <p className="pointer-events-none absolute top-3 left-4 text-[14px] text-faint">Type Your Reply...</p>}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
