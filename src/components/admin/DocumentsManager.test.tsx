import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const uploadDocument = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  uploadDocument: (...a: unknown[]) => uploadDocument(...a),
  editDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));
vi.mock('../../lib/content', () => ({
  fetchDocuments: vi.fn().mockResolvedValue([]),
}));

import DocumentsManager from './DocumentsManager';

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

// jsdom does not recompute a required file input's validity after
// fireEvent.change sets `.files` programmatically, so a real button click
// gets blocked by stale native constraint validation before the submit
// handler ever runs. Dispatching `submit` on the form directly exercises
// the same onSubmit handler without depending on that jsdom quirk.
function submitForm() {
  const form = fileInput().closest('form') as HTMLFormElement;
  fireEvent.submit(form);
}

describe('DocumentsManager upload types', () => {
  beforeEach(() => uploadDocument.mockClear());

  it('accepts the widened extension set on the file input', async () => {
    render(<DocumentsManager />);
    await screen.findByText(/upload a document/i);
    const accept = fileInput().getAttribute('accept') ?? '';
    for (const ext of [
      '.pdf',
      '.txt',
      '.md',
      '.csv',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
    ]) {
      expect(accept).toContain(ext);
    }
  });

  it('uploads a non-PDF allowed type (.csv)', async () => {
    render(<DocumentsManager />);
    await screen.findByText(/upload a document/i);
    fireEvent.change(screen.getByPlaceholderText(/bylaws/i), {
      target: { value: 'Roster' },
    });
    fireEvent.change(fileInput(), {
      target: {
        files: [new File(['a,b'], 'roster.csv', { type: 'text/csv' })],
      },
    });
    submitForm();
    await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(1));
    expect(uploadDocument.mock.calls[0][0].name).toBe('roster.csv');
  });

  it('rejects a disallowed extension with a friendly message and no upload', async () => {
    render(<DocumentsManager />);
    await screen.findByText(/upload a document/i);
    fireEvent.change(screen.getByPlaceholderText(/bylaws/i), {
      target: { value: 'Bad' },
    });
    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'evil.exe', { type: '' })] },
    });
    submitForm();
    await waitFor(() =>
      expect(screen.getByText(/unsupported file type/i)).toBeInTheDocument(),
    );
    expect(uploadDocument).not.toHaveBeenCalled();
  });
});
