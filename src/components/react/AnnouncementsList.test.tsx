import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Announcement } from '../../lib/types';
import AnnouncementsList from './AnnouncementsList';

const sample: Announcement[] = [
  {
    id: '1',
    title: 'Pool opens Saturday',
    body: 'See you there!',
    date: '2026-06-20',
    visibility: 'public',
  },
  {
    id: '2',
    title: 'Annual meeting',
    body: 'Agenda attached.',
    date: '2026-06-10',
    visibility: 'public',
  },
  {
    id: '3',
    title: 'Landscaping update',
    body: 'New shrubs.',
    date: '2026-05-30',
    visibility: 'public',
  },
];

describe('AnnouncementsList', () => {
  it('renders the announcements passed as a prop (no client fetch)', () => {
    render(<AnnouncementsList items={sample} />);
    expect(screen.getByText('Pool opens Saturday')).toBeInTheDocument();
    expect(screen.getByText('Annual meeting')).toBeInTheDocument();
    // No loading placeholder — content is server-rendered.
    expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
  });

  it('shows an empty message when there are no announcements', () => {
    render(<AnnouncementsList items={[]} />);
    expect(screen.getByText(/No announcements yet/i)).toBeInTheDocument();
  });

  it('respects the limit and shows a "view all" link when truncated', () => {
    render(<AnnouncementsList items={sample} limit={2} showMoreLink />);
    expect(screen.getByText('Pool opens Saturday')).toBeInTheDocument();
    expect(screen.queryByText('Landscaping update')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /view all announcements/i });
    expect(link).toHaveAttribute('href', '/announcements');
  });
});
