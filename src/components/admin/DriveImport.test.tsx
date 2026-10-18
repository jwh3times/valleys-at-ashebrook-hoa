import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';

const { fetchDriveStatus, previewDriveFiles, importDriveFile } = vi.hoisted(
  () => ({
    fetchDriveStatus: vi.fn(),
    previewDriveFiles: vi.fn(),
    importDriveFile: vi.fn(),
  }),
);
vi.mock('../../lib/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/drive')>()),
  fetchDriveStatus: (...a: unknown[]) => fetchDriveStatus(...a),
  previewDriveFiles: (...a: unknown[]) => previewDriveFiles(...a),
  importDriveFile: (...a: unknown[]) => importDriveFile(...a),
}));

import { DriveImportButton } from './DriveImport';

// #290 slice 3 (spec decision 8): "Import from Google Drive" beside Upload,
// the preview table, and per-file import results.

const status = (state: 'none' | 'connected' | 'broken') => ({
  configured: true,
  status: state,
  canManage: false,
  googleEmail: 'association@example.test',
});

const previewRows = [
  {
    fileId: 'f-doc',
    name: 'Bylaws draft',
    plan: 'export',
    storedAs: 'pdf',
    filename: 'Bylaws draft.pdf',
    title: 'Bylaws draft',
    modifiedTime: '2026-10-01T12:00:00.000Z',
    newerVersionOf: [],
    nearDuplicates: [],
  },
  {
    fileId: 'f-sheet',
    name: 'Budget 2027',
    plan: 'export',
    storedAs: 'xlsx',
    filename: 'Budget 2027.xlsx',
    title: 'Budget 2027',
    modifiedTime: '2026-10-02T12:00:00.000Z',
    newerVersionOf: [{ id: 'd-1', title: 'Budget 2027' }],
    nearDuplicates: [],
  },
  {
    fileId: 'f-link',
    name: 'Shortcut to minutes',
    plan: 'refused',
    refusal: 'Pick the original file, not a shortcut.',
  },
];

const pick = vi.fn();

beforeEach(() => {
  fetchDriveStatus.mockReset();
  previewDriveFiles.mockReset();
  importDriveFile.mockReset();
  pick.mockReset();
});

async function openPreview() {
  fetchDriveStatus.mockResolvedValue(status('connected'));
  pick.mockResolvedValue(['f-doc', 'f-sheet', 'f-link']);
  previewDriveFiles.mockResolvedValue(previewRows);
  const onImported = vi.fn();
  render(<DriveImportButton pick={pick} onImported={onImported} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Import from Google Drive' }),
  );
  await screen.findByText('Shortcut to minutes');
  return { onImported };
}

const batchCategory = () =>
  screen.getByRole('combobox', { name: 'Category for every file' });

describe('Import from Google Drive', () => {
  it('is hidden while the Drive import is not configured', async () => {
    fetchDriveStatus.mockResolvedValue(null);
    const { container } = render(
      <DriveImportButton pick={pick} onImported={vi.fn()} />,
    );
    await waitFor(() => expect(fetchDriveStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['none', /Google Drive isn't connected/],
    ['broken', /stopped working/],
  ] as const)(
    'is disabled, with the reason, when the connection is %s',
    async (state, reason) => {
      fetchDriveStatus.mockResolvedValue(status(state));
      render(<DriveImportButton pick={pick} onImported={vi.fn()} />);
      expect(
        await screen.findByRole('button', { name: 'Import from Google Drive' }),
      ).toBeDisabled();
      expect(screen.getByText(reason)).toBeInTheDocument();
    },
  );

  it('tells the board admin to sign in to the association account', async () => {
    fetchDriveStatus.mockResolvedValue(status('connected'));
    render(<DriveImportButton pick={pick} onImported={vi.fn()} />);
    expect(
      await screen.findByText(/sign in to that account in this browser/),
    ).toBeInTheDocument();
  });

  it('previews each picked file, refusals included', async () => {
    await openPreview();
    expect(previewDriveFiles).toHaveBeenCalledWith([
      'f-doc',
      'f-sheet',
      'f-link',
    ]);
    expect(
      screen.getByText('Pick the original file, not a shortcut.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/newer version of "Budget 2027"/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Title: Bylaws draft' }),
    ).toHaveValue('Bylaws draft');
    expect(
      screen.queryByRole('textbox', { name: 'Title: Shortcut to minutes' }),
    ).toBeNull();
  });

  it('needs a category before it imports, and defaults visibility to board', async () => {
    await openPreview();
    const importButton = screen.getByRole('button', { name: 'Import' });
    expect(importButton).toBeDisabled();
    expect(
      screen.getByRole('combobox', { name: 'Visibility for every file' }),
    ).toHaveValue('board');
    fireEvent.change(batchCategory(), {
      target: { value: 'Governing Documents' },
    });
    expect(importButton).toBeEnabled();
  });

  it('imports each importable file once, in order, with its own settings', async () => {
    const { onImported } = await openPreview();
    importDriveFile.mockResolvedValue({ kind: 'imported', id: 'new' });
    fireEvent.change(batchCategory(), {
      target: { value: 'Governing Documents' },
    });
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Title: Budget 2027' }),
      { target: { value: 'Budget 2027 (approved)' } },
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Visibility: Budget 2027' }),
      { target: { value: 'homeowner' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(importDriveFile).toHaveBeenCalledTimes(2));
    expect(importDriveFile.mock.calls.map((c) => c[0])).toEqual([
      {
        fileId: 'f-doc',
        expectedModifiedTime: '2026-10-01T12:00:00.000Z',
        title: 'Bylaws draft',
        category: 'Governing Documents',
        visibility: 'board',
        confirmDuplicate: false,
      },
      {
        fileId: 'f-sheet',
        expectedModifiedTime: '2026-10-02T12:00:00.000Z',
        title: 'Budget 2027 (approved)',
        category: 'Governing Documents',
        visibility: 'homeowner',
        confirmDuplicate: false,
      },
    ]);
    expect(await screen.findAllByText('Imported')).toHaveLength(2);
    expect(onImported).toHaveBeenCalled();
  });

  it('offers to import a near-duplicate anyway, resending only that file', async () => {
    await openPreview();
    importDriveFile
      .mockResolvedValueOnce({ kind: 'imported', id: 'new' })
      .mockResolvedValueOnce({
        kind: 'near-duplicate',
        similar: [{ id: 'd-1', title: 'Budget 2027' }],
      })
      .mockResolvedValueOnce({ kind: 'imported', id: 'new-2' });
    fireEvent.change(batchCategory(), {
      target: { value: 'Governing Documents' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Import anyway: Budget 2027',
      }),
    );
    await waitFor(() => expect(importDriveFile).toHaveBeenCalledTimes(3));
    expect(importDriveFile.mock.calls[2][0]).toMatchObject({
      fileId: 'f-sheet',
      confirmDuplicate: true,
    });
  });

  it("shows a file's refusal in its row and carries on with the rest", async () => {
    await openPreview();
    importDriveFile
      .mockResolvedValueOnce({
        kind: 'failed',
        message:
          'This file changed in Drive after the preview. Preview it again.',
      })
      .mockResolvedValueOnce({ kind: 'imported', id: 'new' });
    fireEvent.change(batchCategory(), {
      target: { value: 'Governing Documents' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const row = (await screen.findByText(/changed in Drive/)).closest('tr')!;
    expect(within(row).getByText('Bylaws draft')).toBeInTheDocument();
    expect(await screen.findByText('Imported')).toBeInTheDocument();
  });
});
