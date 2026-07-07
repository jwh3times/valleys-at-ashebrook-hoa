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
          suggestedKeepId: 'keep',
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
          suggestedKeepId: 'x',
          reason: 'similar filename/size',
          members: [member('x', 'Report.pdf'), member('y', 'Report copy.pdf')],
        },
      ],
      remaining: 0,
    });
    render(<DuplicatesManager />);
    expect(await screen.findByText(/Report\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/similar filename\/size/i)).toBeInTheDocument();
  });
});
