import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const fetchAnnouncements = vi.fn().mockResolvedValue([
  {
    id: 'announcement-1',
    title: 'Pool closure',
    body: 'Closed for repairs.',
    date: '2026-09-03',
    pinned: false,
    visibility: 'public',
  },
]);

vi.mock('../../lib/content', () => ({
  fetchAnnouncements: (...args: unknown[]) => fetchAnnouncements(...args),
}));
vi.mock('../../lib/admin', () => ({
  deleteAnnouncement: vi.fn(),
  saveAnnouncement: vi.fn(),
}));

import AnnouncementsManager from './AnnouncementsManager';

describe('AnnouncementsManager', () => {
  it('names each row action with the announcement title', async () => {
    render(<AnnouncementsManager />);

    expect(
      await screen.findByRole('button', {
        name: 'Edit announcement: Pool closure',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete announcement: Pool closure' }),
    ).toBeInTheDocument();
  });
});
