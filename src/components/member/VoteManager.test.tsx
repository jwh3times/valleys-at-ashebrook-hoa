import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import VoteManager from './VoteManager';
import * as voting from '../../lib/voting';
import type { OpenVotingItem } from '../../lib/types';

vi.mock('../../lib/voting');
const mocked = vi.mocked(voting);

const election: OpenVotingItem = {
  kind: 'election',
  id: 'e1',
  title: 'Board election',
  date: '2026-10-01',
  seats: 1,
  candidates: [
    {
      id: 'c1',
      fullName: 'Candidate One',
      statementMd: 'Candidate statement.',
    },
    { id: 'c2', fullName: 'Candidate Two', statementMd: null },
  ],
  lots: [
    {
      propertyId: 'p1',
      address: '101 Example Street',
      weight: 1,
      hasCast: false,
      ownerOptions: [{ id: 'o1', fullName: 'Owner One' }],
      proxyOptions: [
        { id: 'px1', holderName: 'You', grantingAddress: '102 Example Street' },
      ],
    },
  ],
};

const motion: OpenVotingItem = {
  kind: 'motion',
  id: 'm1',
  text: 'Approve the landscaping contract.',
  meetingId: 'mt1',
  meetingTitle: 'Member meeting',
  meetingDate: '2026-10-01',
  lots: [
    {
      propertyId: 'p1',
      address: '101 Example Street',
      weight: 1,
      hasCast: false,
      ownerOptions: [{ id: 'o1', fullName: 'Owner One' }],
      proxyOptions: [
        { id: 'px1', holderName: 'You', grantingAddress: '102 Example Street' },
      ],
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocked.castBallot.mockResolvedValue();
  mocked.castMotionVote.mockResolvedValue();
});

describe('VoteManager', () => {
  it('requires a final confirmation and replaces a successful ballot with a private receipt', async () => {
    render(<VoteManager items={[election]} />);

    fireEvent.click(screen.getByLabelText('Candidate One'));
    fireEvent.click(screen.getByRole('button', { name: /review ballot/i }));

    expect(screen.getByText(/cannot be changed or recovered/i)).toBeVisible();
    expect(mocked.castBallot).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /cast final ballot/i }));

    expect(
      await screen.findByText(/ballot received for 101 example street/i),
    ).toBeVisible();
    expect(screen.queryByText('Candidate One')).not.toBeInTheDocument();
    expect(mocked.castBallot).toHaveBeenCalledWith({
      electionId: 'e1',
      propertyId: 'p1',
      candidateIds: ['c1'],
      castByOwnerId: 'o1',
      proxyId: null,
    });
  });

  it('enforces the seat limit and accepts a proxy provenance selection', async () => {
    render(<VoteManager items={[{ ...election, seats: 1 }]} />);

    fireEvent.click(screen.getByLabelText('Candidate One'));
    fireEvent.click(screen.getByLabelText('Candidate Two'));
    expect(screen.getByLabelText('Candidate One')).toBeChecked();
    expect(screen.getByLabelText('Candidate Two')).not.toBeChecked();

    fireEvent.click(screen.getByLabelText(/vote by proxy/i));
    fireEvent.click(screen.getByRole('button', { name: /review ballot/i }));
    fireEvent.click(screen.getByRole('button', { name: /cast final ballot/i }));

    await waitFor(() =>
      expect(mocked.castBallot).toHaveBeenCalledWith({
        electionId: 'e1',
        propertyId: 'p1',
        candidateIds: ['c1'],
        castByOwnerId: null,
        proxyId: 'px1',
      }),
    );
  });

  it('supports multiple selections up to the available seats', async () => {
    render(<VoteManager items={[{ ...election, seats: 2 }]} />);
    fireEvent.click(screen.getByLabelText('Candidate One'));
    fireEvent.click(screen.getByLabelText('Candidate Two'));
    fireEvent.click(screen.getByRole('button', { name: /review ballot/i }));
    fireEvent.click(screen.getByRole('button', { name: /cast final ballot/i }));

    await waitFor(() =>
      expect(mocked.castBallot).toHaveBeenCalledWith(
        expect.objectContaining({ candidateIds: ['c1', 'c2'] }),
      ),
    );
  });

  it('casts a motion choice with the selected owner', async () => {
    render(<VoteManager items={[motion]} />);
    fireEvent.click(screen.getByLabelText('Yes'));
    fireEvent.click(screen.getByRole('button', { name: /review vote/i }));
    fireEvent.click(screen.getByRole('button', { name: /cast final vote/i }));

    await waitFor(() =>
      expect(mocked.castMotionVote).toHaveBeenCalledWith({
        motionId: 'm1',
        propertyId: 'p1',
        choice: 'yes',
        castByOwnerId: 'o1',
        proxyId: null,
      }),
    );
  });

  it('shows a server failure and keeps the form available for correction', async () => {
    mocked.castBallot.mockRejectedValue(
      new Error('This lot has already voted'),
    );
    render(<VoteManager items={[election]} />);
    fireEvent.click(screen.getByLabelText('Candidate One'));
    fireEvent.click(screen.getByRole('button', { name: /review ballot/i }));
    fireEvent.click(screen.getByRole('button', { name: /cast final ballot/i }));

    expect(await screen.findByText('This lot has already voted')).toBeVisible();
    expect(screen.getByLabelText('Candidate One')).toBeEnabled();
  });
});
