import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { uploadDocument, fetchAdminDocuments, DuplicateError } = vi.hoisted(
  () => {
    const uploadDocument = vi.fn().mockResolvedValue(undefined);
    const fetchAdminDocuments = vi.fn().mockResolvedValue([]);
    class DuplicateError extends Error {
      kind: 'exact' | 'near';
      existing?: {
        id: string;
        title: string;
        category: string;
        visibility: string;
      };
      similar?: { id: string; title: string; filename: string }[];

      constructor(kind: 'exact' | 'near', payload: Record<string, unknown>) {
        super(kind);
        this.name = 'DuplicateError';
        this.kind = kind;
        Object.assign(this, payload);
      }
    }
    return { uploadDocument, fetchAdminDocuments, DuplicateError };
  },
);
vi.mock('../../lib/admin', () => ({
  uploadDocument: (...a: unknown[]) => uploadDocument(...a),
  editDocument: vi.fn(),
  deleteDocument: vi.fn(),
  fetchAdminDocuments: (...a: unknown[]) => fetchAdminDocuments(...a),
  DuplicateError,
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

describe('DocumentsManager visibility filter', () => {
  const docs = [
    {
      id: '1',
      title: 'Alpha Doc',
      category: 'Governing Documents',
      visibility: 'board',
      updatedAt: '2026-01-01',
    },
    {
      id: '2',
      title: 'Beta Doc',
      category: 'Meeting Minutes',
      visibility: 'board',
      updatedAt: '2026-01-01',
    },
    {
      id: '3',
      title: 'Gamma Doc',
      category: 'Forms',
      visibility: 'public',
      updatedAt: '2026-01-01',
    },
  ];

  beforeEach(() => fetchAdminDocuments.mockResolvedValue(docs));

  it('shows every document by default with a per-tier count on each tab', async () => {
    render(<DocumentsManager />);
    expect(await screen.findByText('Alpha Doc')).toBeInTheDocument();
    expect(screen.getByText('Beta Doc')).toBeInTheDocument();
    expect(screen.getByText('Gamma Doc')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /All \(3\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Public \(1\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Homeowners \(0\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Board \(2\)/ }),
    ).toBeInTheDocument();
  });

  it('shows only the selected tier when a tab is clicked', async () => {
    render(<DocumentsManager />);
    await screen.findByText('Alpha Doc');
    fireEvent.click(screen.getByRole('button', { name: /Board \(2\)/ }));
    expect(screen.getByText('Alpha Doc')).toBeInTheDocument();
    expect(screen.getByText('Beta Doc')).toBeInTheDocument();
    expect(screen.queryByText('Gamma Doc')).not.toBeInTheDocument();
  });

  it('shows an empty message when no documents match the selected tab', async () => {
    render(<DocumentsManager />);
    await screen.findByText('Alpha Doc');
    fireEvent.click(screen.getByRole('button', { name: /Homeowners \(0\)/ }));
    expect(screen.queryByText('Alpha Doc')).not.toBeInTheDocument();
    expect(
      screen.getByText(/no documents are set to this visibility/i),
    ).toBeInTheDocument();
  });
});

describe('DocumentsManager duplicate handling', () => {
  beforeEach(() => uploadDocument.mockReset());

  function fillAndSubmit() {
    fireEvent.change(screen.getByPlaceholderText(/bylaws/i), {
      target: { value: 'Minutes' },
    });
    fireEvent.change(fileInput(), {
      target: {
        files: [new File(['x'], 'minutes.pdf', { type: 'application/pdf' })],
      },
    });
    submitForm();
  }

  it('shows a blocking message on an exact duplicate and offers no override', async () => {
    uploadDocument.mockRejectedValueOnce(
      new DuplicateError('exact', {
        existing: {
          id: '1',
          title: 'Existing Minutes',
          category: 'Other',
          visibility: 'board',
        },
      }),
    );
    render(<DocumentsManager />);
    await screen.findByText(/upload a document/i);
    fillAndSubmit();
    await waitFor(() =>
      expect(screen.getByText(/already on the site/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: /upload anyway/i }),
    ).not.toBeInTheDocument();
  });

  it('shows an "Upload anyway" action on a near duplicate and re-submits confirmed', async () => {
    uploadDocument
      .mockRejectedValueOnce(
        new DuplicateError('near', {
          similar: [{ id: '2', title: 'Close Minutes', filename: 'close.pdf' }],
        }),
      )
      .mockResolvedValueOnce(undefined);
    render(<DocumentsManager />);
    await screen.findByText(/upload a document/i);
    fillAndSubmit();
    const anyway = await screen.findByRole('button', {
      name: /upload anyway/i,
    });
    fireEvent.click(anyway);
    await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(2));
    expect(uploadDocument.mock.calls[1][4]).toBe(true);
  });
});

describe('DocumentsManager searchability badge', () => {
  beforeEach(() =>
    fetchAdminDocuments.mockResolvedValue([
      {
        id: '1',
        title: 'Scanned Deed',
        category: 'Maps & Deeds',
        visibility: 'board',
        updatedAt: '2026-01-01',
        ragStatus: 'unsupported',
      },
      {
        id: '2',
        title: 'Clean Bylaws',
        category: 'Governing Documents',
        visibility: 'board',
        updatedAt: '2026-01-01',
        ragStatus: 'ok',
      },
    ]),
  );

  it('shows a "Not searchable" badge only for unsupported documents', async () => {
    render(<DocumentsManager />);
    await screen.findByText('Scanned Deed');
    expect(screen.getByText('Clean Bylaws')).toBeInTheDocument();
    // Exactly one badge — the scanned doc, not the clean one.
    expect(screen.getAllByText(/not searchable/i)).toHaveLength(1);
  });
});

describe('DocumentsManager search', () => {
  const docs = [
    {
      id: '1',
      title: 'Annual Budget',
      category: 'Financials',
      visibility: 'board',
      updatedAt: '2026-01-01',
      filename: 'budget-2026.pdf',
    },
    {
      id: '2',
      title: 'Meeting Minutes',
      category: 'Meeting Minutes',
      visibility: 'public',
      updatedAt: '2026-01-01',
      filename: 'minutes-jan.pdf',
    },
    {
      id: '3',
      title: 'Community Bylaws',
      category: 'Governing Documents',
      visibility: 'board',
      updatedAt: '2026-01-01',
      filename: 'bylaws.pdf',
    },
  ];

  beforeEach(() => fetchAdminDocuments.mockResolvedValue(docs));

  function searchBox() {
    return screen.getByPlaceholderText(/search by title or filename/i);
  }

  it('narrows the list to documents whose title matches the query', async () => {
    render(<DocumentsManager />);
    await screen.findByText('Annual Budget');
    fireEvent.change(searchBox(), { target: { value: 'bylaws' } });
    expect(screen.getByText('Community Bylaws')).toBeInTheDocument();
    expect(screen.queryByText('Annual Budget')).not.toBeInTheDocument();
    expect(screen.queryByText('Meeting Minutes')).not.toBeInTheDocument();
  });

  it('matches on filename when the title does not contain the query', async () => {
    render(<DocumentsManager />);
    await screen.findByText('Annual Budget');
    // 'minutes-jan' is only in the filename of doc 2; also substring of its title,
    // so use the date fragment that is filename-only.
    fireEvent.change(searchBox(), { target: { value: 'jan' } });
    expect(screen.getByText('Meeting Minutes')).toBeInTheDocument();
    expect(screen.queryByText('Annual Budget')).not.toBeInTheDocument();
    expect(screen.queryByText('Community Bylaws')).not.toBeInTheDocument();
  });

  it('composes with the visibility tab as AND', async () => {
    render(<DocumentsManager />);
    await screen.findByText('Annual Budget');
    // Board tab: docs 1 and 3. Query 'community' further narrows to doc 3.
    fireEvent.click(screen.getByRole('button', { name: /Board \(2\)/ }));
    fireEvent.change(searchBox(), { target: { value: 'community' } });
    expect(screen.getByText('Community Bylaws')).toBeInTheDocument();
    expect(screen.queryByText('Annual Budget')).not.toBeInTheDocument();
  });

  it('shows a search-specific empty message when nothing matches', async () => {
    render(<DocumentsManager />);
    await screen.findByText('Annual Budget');
    fireEvent.change(searchBox(), { target: { value: 'zzzznomatch' } });
    expect(
      screen.getByText(/no documents match your search/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/no documents are set to this visibility/i),
    ).not.toBeInTheDocument();
  });
});
