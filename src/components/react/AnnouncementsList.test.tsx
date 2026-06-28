import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  waitForElementToBeRemoved,
} from '@testing-library/react';
import type { Announcement } from '../../lib/types';

vi.mock('../../lib/content', async (orig) => ({
  ...(await orig<typeof import('../../lib/content')>()),
  fetchAnnouncements: vi.fn(),
}));

import AnnouncementsList from './AnnouncementsList';
import { fetchAnnouncements } from '../../lib/content';

const sample: Announcement[] = [
  {
    id: '1',
    title: 'Pool opens Saturday',
    body: 'See you there!',
    date: '2026-06-20',
  },
  {
    id: '2',
    title: 'Annual meeting',
    body: 'Agenda attached.',
    date: '2026-06-10',
  },
  {
    id: '3',
    title: 'Landscaping update',
    body: 'New shrubs.',
    date: '2026-05-30',
  },
  {
    id: '4',
    title: 'Welcome new neighbors',
    body: 'Hello!',
    date: '2026-05-01',
  },
];

describe('AnnouncementsList', () => {
  beforeEach(() => {
    vi.mocked(fetchAnnouncements).mockReset();
  });

  it('shows a loading state, then the announcements', async () => {
    vi.mocked(fetchAnnouncements).mockResolvedValue(sample);
    render(<AnnouncementsList />);
    expect(screen.getByText(/Loading announcements/i)).toBeInTheDocument();
    await waitForElementToBeRemoved(() =>
      screen.queryByText(/Loading announcements/i),
    );
    expect(screen.getByText('Pool opens Saturday')).toBeInTheDocument();
    expect(screen.getByText('Annual meeting')).toBeInTheDocument();
  });

  it('shows an empty message when there are no announcements', async () => {
    vi.mocked(fetchAnnouncements).mockResolvedValue([]);
    render(<AnnouncementsList />);
    expect(
      await screen.findByText(/No announcements yet/i),
    ).toBeInTheDocument();
  });

  it('respects the limit and shows a "view all" link when truncated', async () => {
    vi.mocked(fetchAnnouncements).mockResolvedValue(sample);
    render(<AnnouncementsList limit={2} showMoreLink />);
    expect(await screen.findByText('Pool opens Saturday')).toBeInTheDocument();
    expect(screen.queryByText('Landscaping update')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /view all announcements/i });
    expect(link).toHaveAttribute('href', '/announcements');
  });

  it('shows an error message when loading fails', async () => {
    vi.mocked(fetchAnnouncements).mockRejectedValue(new Error('boom'));
    render(<AnnouncementsList />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
