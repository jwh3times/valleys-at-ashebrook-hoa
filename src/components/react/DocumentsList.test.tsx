import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DocumentItem } from '../../lib/types';

vi.mock('../../lib/content', async (orig) => ({
  ...(await orig<typeof import('../../lib/content')>()),
  fetchDocuments: vi.fn(),
}));

import DocumentsList from './DocumentsList';
import { fetchDocuments } from '../../lib/content';

const docs: DocumentItem[] = [
  {
    id: 'a',
    title: 'Bylaws',
    category: 'Governing Documents',
    url: 'https://example.com/bylaws.pdf',
    storagePath: 'documents/bylaws.pdf',
    updatedAt: '2026-01-01',
    visibility: 'public',
  },
  {
    id: 'b',
    title: 'March Minutes',
    category: 'Meeting Minutes',
    url: 'https://example.com/march.pdf',
    storagePath: 'documents/march.pdf',
    updatedAt: '2026-03-15',
    visibility: 'public',
  },
];

describe('DocumentsList', () => {
  beforeEach(() => vi.mocked(fetchDocuments).mockReset());

  it('groups documents by category with working download links', async () => {
    vi.mocked(fetchDocuments).mockResolvedValue(docs);
    render(<DocumentsList />);

    expect(
      await screen.findByRole('heading', { name: 'Governing Documents' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Meeting Minutes' }),
    ).toBeInTheDocument();

    const links = screen.getAllByRole('link', { name: /download/i });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/bylaws.pdf');
  });

  it('shows an empty message when there are no documents', async () => {
    vi.mocked(fetchDocuments).mockResolvedValue([]);
    render(<DocumentsList />);
    expect(
      await screen.findByText(/No documents have been posted yet/i),
    ).toBeInTheDocument();
  });
});
