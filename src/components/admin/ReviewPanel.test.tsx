import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchReviewFlags = vi.fn();
const resolveReviewFlag = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/roster-admin', () => ({
  fetchReviewFlags: (...a: unknown[]) => fetchReviewFlags(...a),
  resolveReviewFlag: (...a: unknown[]) => resolveReviewFlag(...a),
  REVIEW_RESOLUTION_CODES: ['remediated', 'confirmed_valid', 'no_effect'],
}));

import ReviewPanel from './ReviewPanel';

const flag = (over: Record<string, unknown> = {}) => ({
  id: 'flag-1',
  category: 'intervening_action_backdated',
  status: 'open',
  openedAt: 1_755_000_000_000,
  resolvedAt: null,
  resolutionCode: null,
  sourceEventId: 'evt-1',
  sourceEvent: {
    eventKind: 'ownership_ended',
    family: 'roster_change',
    recordedAt: 1_755_000_000_000,
    actorKind: 'account',
    actorAccountId: 'acct-9',
    automaticCause: null,
  },
  impacted: { kind: 'member_vote', id: 'mv-7' },
  ...over,
});

describe('ReviewPanel', () => {
  beforeEach(() => {
    fetchReviewFlags.mockReset();
    resolveReviewFlag.mockClear();
    resolveReviewFlag.mockResolvedValue(undefined);
  });

  it('shows an empty state when there are no flags', async () => {
    fetchReviewFlags.mockResolvedValue([]);
    render(<ReviewPanel />);
    expect(await screen.findByText(/no review flags/i)).toBeInTheDocument();
  });

  it('renders an open flag with its category label, source event, and impacted record', async () => {
    fetchReviewFlags.mockResolvedValue([flag()]);
    render(<ReviewPanel />);
    expect(
      await screen.findByText(/Intervening action \(backdated change\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/roster_change \/ ownership_ended/),
    ).toBeInTheDocument();
    expect(screen.getByText(/acct-9/)).toBeInTheDocument();
    expect(screen.getByText(/Member vote: mv-7/)).toBeInTheDocument();
  });

  it('renders a flag whose impacted record is gone as deleted or replaced', async () => {
    fetchReviewFlags.mockResolvedValue([flag({ impacted: null })]);
    render(<ReviewPanel />);
    expect(
      await screen.findByText(
        /referenced record has since been deleted or replaced/i,
      ),
    ).toBeInTheDocument();
  });

  it('offers exactly the three manual resolution codes and never superseded', async () => {
    fetchReviewFlags.mockResolvedValue([flag()]);
    render(<ReviewPanel />);
    const select = await screen.findByLabelText(/how was this reviewed/i);
    const values = Array.from(
      select.querySelectorAll('option'),
      (o) => o.value,
    );
    expect(values).toEqual(['', 'remediated', 'confirmed_valid', 'no_effect']);
    expect(values).not.toContain('superseded');
    expect(
      screen.getByRole('button', {
        name: 'Resolve Intervening action (backdated change) flag: flag-1',
      }),
    ).toBeInTheDocument();
  });

  it('resolves an open flag with the chosen code and reloads', async () => {
    fetchReviewFlags.mockResolvedValue([flag()]);
    render(<ReviewPanel />);
    const select = await screen.findByLabelText(/how was this reviewed/i);
    fireEvent.change(select, { target: { value: 'confirmed_valid' } });
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));
    await waitFor(() =>
      expect(resolveReviewFlag).toHaveBeenCalledWith(
        'flag-1',
        'confirmed_valid',
      ),
    );
    expect(fetchReviewFlags).toHaveBeenCalledTimes(2);
  });

  it('shows a resolved flag with its resolution code and no resolve control', async () => {
    fetchReviewFlags.mockResolvedValue([
      flag({
        status: 'resolved',
        resolvedAt: 1_755_100_000_000,
        resolutionCode: 'superseded',
        category: 'vote_reset_on_transfer',
      }),
    ]);
    render(<ReviewPanel />);
    expect(
      await screen.findByText(/superseded by a correction/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /resolve/i }),
    ).not.toBeInTheDocument();
  });

  it('surfaces the server message when a resolve is refused', async () => {
    fetchReviewFlags.mockResolvedValue([flag()]);
    resolveReviewFlag.mockRejectedValue(
      new Error('This flag has already been resolved'),
    );
    render(<ReviewPanel />);
    const select = await screen.findByLabelText(/how was this reviewed/i);
    fireEvent.change(select, { target: { value: 'no_effect' } });
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));
    expect(
      await screen.findByText(/This flag has already been resolved/i),
    ).toBeInTheDocument();
  });
});
