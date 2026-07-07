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

  it('resolves an exact group with one click keeping the suggested id', async () => {
    fetchDuplicates.mockResolvedValue({
      exact: [
        {
          matchKind: 'exact',
          suggestedKeepId: 'keep',
          contentHash: 'f'.repeat(64),
          sameTier: true,
          autoResolvable: true,
          deleteIds: ['drop'],
          recommendation:
            'Same-tier exact duplicate: keep the suggested file and delete the byte-identical copies.',
          members: [member('keep', 'a.pdf'), member('drop', 'a(1).pdf')],
        },
      ],
      near: [],
      remaining: 0,
    });
    render(<DuplicatesManager />);
    const btn = await screen.findByRole('button', {
      name: /keep suggested/i,
    });
    expect(screen.getAllByText(/same-tier exact/i).length).toBeGreaterThan(0);
    expect(screen.getByText('f'.repeat(64))).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(resolveDuplicates).toHaveBeenCalledWith('keep', ['drop']),
    );
  });

  it('renders a near group as needing manual review', async () => {
    fetchDuplicates.mockResolvedValue({
      exact: [],
      near: [
        {
          matchKind: 'near',
          suggestedKeepId: 'x',
          reason: 'similar filename/size',
          autoResolvable: false,
          recommendation:
            'Near duplicate: metadata is similar, but bytes differ or are not yet proven identical. Review manually before deleting.',
          members: [member('x', 'Report.pdf'), member('y', 'Report copy.pdf')],
        },
      ],
      remaining: 0,
    });
    render(<DuplicatesManager />);
    expect(await screen.findByText(/Report\.pdf/)).toBeInTheDocument();
    expect(screen.getAllByText(/near match/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/similar filename\/size/i)).toBeInTheDocument();
    expect(
      screen.getByText(member('x', 'Report.pdf').contentHash),
    ).toBeInTheDocument();
  });
});
