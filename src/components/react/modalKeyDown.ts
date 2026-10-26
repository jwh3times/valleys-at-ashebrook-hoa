import type { KeyboardEvent } from 'react';

// The keyboard half of a modal dialog's focus trap, shared by the member vote
// dialog and the admin request-queue dialog: Escape cancels unless the dialog
// is busy, and Tab and Shift+Tab cycle among the dialog's enabled controls.

export const MODAL_FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)';

export function handleModalKeyDown(
  event: KeyboardEvent<HTMLElement>,
  dialog: HTMLElement | null,
  busy: boolean,
  onCancel: () => void,
): void {
  if (event.key === 'Escape' && !busy) {
    event.preventDefault();
    onCancel();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    dialog?.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE) ?? [],
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
