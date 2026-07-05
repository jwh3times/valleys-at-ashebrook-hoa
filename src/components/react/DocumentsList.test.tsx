import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DocumentItem } from '../../lib/types';
import DocumentsList from './DocumentsList';

const docs: DocumentItem[] = [
  {
    id: 'a',
    title: 'Bylaws',
    category: 'Governing Documents',
    updatedAt: '2026-01-01',
    visibility: 'public',
  },
  {
    id: 'b',
    title: 'March Minutes',
    category: 'Meeting Minutes',
    updatedAt: '2026-03-15',
    visibility: 'public',
  },
];

describe('DocumentsList', () => {
  it('groups documents by category with working download links', () => {
    render(<DocumentsList docs={docs} />);
    expect(
      screen.getByRole('heading', { name: 'Governing Documents' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Meeting Minutes' }),
    ).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /download/i });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/api/files/a');
  });

  it('shows an empty message when there are no documents', () => {
    render(<DocumentsList docs={[]} />);
    expect(
      screen.getByText(/No documents have been posted yet/i),
    ).toBeInTheDocument();
  });
});
