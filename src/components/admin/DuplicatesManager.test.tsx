import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchDuplicates = vi.fn();
const resolveDuplicates = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  fetchDuplicates: (...a: unknown[]) => fetchDuplicates(...a),
  resolveDuplicates: (...a: unknown[]) => resolveDuplicates(...a),
}));

import DuplicatesManager from './DuplicatesManager';

const member = (id: string, filename: string) => ({
  id,
  title: filename.replace(/\.[^.]+$/, ''),
  filename,
  category: 'Other',
  visibility: 'board',
  sizeBytes: 100,
  contentHash: `${id}${'0'.repeat(63)}`.slice(0, 64),
  uploadedAt: '2026-01-01T00:00:00.000Z',
  verifiedAt: null as string | null,
});

const exactGroup = () => ({
  matchKind: 'exact',
  suggestedKeepId: 'keep',
  contentHash: 'f'.repeat(64),
  sameTier: true,
  autoResolvable: true,
  recommendation:
    'Same-tier exact duplicate: keep the suggested file and delete the byte-identical copies.',
  members: [member('keep', 'a.pdf'), member('drop', 'a(1).pdf')],
});

const nearGroup = () => ({
  matchKind: 'near',
  suggestedKeepId: 'x',
  reason: 'similar filename/size',
  autoResolvable: false,
  recommendation:
    'Near duplicate: metadata is similar, but bytes differ or are not yet proven identical. Review manually before deleting.',
  members: [member('x', 'Report.pdf'), member('y', 'Report copy.pdf')],
});

describe('DuplicatesManager', () => {
  beforeEach(() => {
    fetchDuplicates.mockReset();
    resolveDuplicates.mockClear();
    vi.stubGlobal('confirm', () => true);
  });

  it('shows a friendly empty state when there are no duplicates', async () => {
    fetchDuplicates.mockResolvedValue({ exact: [], near: [], remaining: 0 });
    render(<DuplicatesManager />);
    expect(await screen.findByText(/no duplicates/i)).toBeInTheDocument();
  });

  it('collapses an exact group to the suggested file via select-all-but-suggested', async () => {
    fetchDuplicates.mockResolvedValue({
      exact: [exactGroup()],
      near: [],
      remaining: 0,
    });
    render(<DuplicatesManager />);
    fireEvent.click(
      await screen.findByRole('button', { name: /select all but suggested/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /delete 1 selected/i }));
    await waitFor(() =>
      expect(resolveDuplicates).toHaveBeenCalledWith(['keep'], ['drop']),
    );
  });

  it('keeps every file in a group when marking it reviewed', async () => {
    fetchDuplicates.mockResolvedValue({
      exact: [],
      near: [nearGroup()],
      remaining: 0,
    });
    render(<DuplicatesManager />);
    fireEvent.click(await screen.findByRole('button', { name: /keep all/i }));
    await waitFor(() =>
      expect(resolveDuplicates).toHaveBeenCalledWith(['x', 'y'], []),
    );
  });

  it('links each member to its file for a visual check', async () => {
    fetchDuplicates.mockResolvedValue({
      exact: [],
      near: [nearGroup()],
      remaining: 0,
    });
    render(<DuplicatesManager />);
    const links = await screen.findAllByRole('link', { name: /view/i });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/api/files/x');
    expect(links[1]).toHaveAttribute('href', '/api/files/y');
  });

  it('prevents deleting every file in a group', async () => {
    fetchDuplicates.mockResolvedValue({
      exact: [exactGroup()],
      near: [],
      remaining: 0,
    });
    render(<DuplicatesManager />);
    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    expect(
      screen.getByRole('button', { name: /keep at least one file/i }),
    ).toBeDisabled();
    expect(resolveDuplicates).not.toHaveBeenCalled();
  });

  it('marks already-kept members with a reviewed indicator', async () => {
    const g = nearGroup();
    g.members[0] = { ...g.members[0], verifiedAt: '2026-07-01T00:00:00.000Z' };
    fetchDuplicates.mockResolvedValue({ exact: [], near: [g], remaining: 0 });
    render(<DuplicatesManager />);
    expect(await screen.findByText(/kept/i)).toBeInTheDocument();
  });

  it('renders a near group as needing manual review', async () => {
    fetchDuplicates.mockResolvedValue({
      exact: [],
      near: [nearGroup()],
      remaining: 0,
    });
    render(<DuplicatesManager />);
    expect(await screen.findByText(/Report\.pdf/)).toBeInTheDocument();
    expect(screen.getAllByText(/near match/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/similar filename\/size/i)).toBeInTheDocument();
  });
});
