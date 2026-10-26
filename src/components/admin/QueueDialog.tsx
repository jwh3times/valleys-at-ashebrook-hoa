import { useEffect, useRef, type ReactNode } from 'react';
import { MODAL_FOCUSABLE, handleModalKeyDown } from '../react/modalKeyDown';

// The decision dialog of a board request queue (#294 slice 3). The Tenants
// panel is the first queue; the verification and correction queues are meant
// to reuse it when they move into the admin panel. A modal with a focus trap:
// Escape cancels, Tab cycles inside it, and focus returns to whatever opened
// it when it closes.

interface Props {
  title: string;
  confirmLabel: string;
  /** False keeps the confirm button disabled, e.g. until a reason is typed. */
  canConfirm?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

export default function QueueDialog({
  title,
  confirmLabel,
  canConfirm = true,
  busy,
  onConfirm,
  onCancel,
  children,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.querySelector<HTMLElement>(MODAL_FOCUSABLE)?.focus();
    return () => opener?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) =>
    handleModalKeyDown(event, dialogRef.current, busy, onCancel);

  return (
    <div className="queue-dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="queue-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={handleKeyDown}
      >
        <h3>{title}</h3>
        {children}
        <div className="btn-row">
          <button
            type="button"
            className="btn btn--outline"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={onConfirm}
            disabled={busy || !canConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
