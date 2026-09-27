import { useEffect, useRef } from 'react';
import { Button } from './Button';

// Confirmation for destructive actions (native <dialog>: focus trap, Esc).
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      open
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="fixed inset-0 z-50 m-auto w-[min(420px,calc(100vw-2rem))] rounded-2xl border border-line bg-white p-5 shadow-xl backdrop:bg-black/20"
    >
      <h2 id="confirm-title" className="text-[15px] font-semibold text-ink">
        {title}
      </h2>
      <p className="mt-2 text-ink-2">{description}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Keep
        </Button>
        <Button variant="danger" onClick={onConfirm} loading={busy}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
