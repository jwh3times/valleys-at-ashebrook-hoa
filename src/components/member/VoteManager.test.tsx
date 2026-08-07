import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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

    const dialog = screen.getByRole('dialog', { name: 'Review ballot' });
    expect(
      within(dialog).getByText(/ballot cannot be changed or recovered/i),
    ).toBeVisible();
    expect(within(dialog).queryByText(/board can correct/i)).toBeNull();
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

  it('associates block candidate statements outside the clickable candidate label', () => {
    const richElection: OpenVotingItem = {
      ...election,
      candidates: [
        {
          ...election.candidates[0],
          statementMd: '## Priorities\n- Keep reserves funded',
        },
        election.candidates[1],
      ],
    };
    const { rerender } = render(<VoteManager items={[richElection]} />);

    const checkbox = screen.getByRole('checkbox', {
      name: 'Candidate One',
    }) as HTMLInputElement;
    const descriptionId = checkbox.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    const statement = document.getElementById(descriptionId!);
    expect(statement).not.toBeNull();
    expect(statement!.closest('label')).toBeNull();
    expect(
      within(statement!).getByRole('heading', { name: 'Priorities' }),
    ).toBeVisible();
    expect(checkbox).toHaveAccessibleDescription(
      /priorities keep reserves funded/i,
    );

    const label = checkbox.labels?.[0];
    expect(label).toHaveTextContent('Candidate One');
    expect(label).not.toContainElement(statement);
    fireEvent.click(within(label!).getByText('Candidate One'));
    expect(checkbox).toBeChecked();

    rerender(<VoteManager items={[richElection]} />);
    expect(
      screen
        .getByRole('checkbox', { name: 'Candidate One' })
        .getAttribute('aria-describedby'),
    ).toBe(descriptionId);
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

  it('explains board correction and replaces a motion vote with a selection-free receipt', async () => {
    render(<VoteManager items={[motion]} />);
    fireEvent.click(screen.getByLabelText('Yes'));
    fireEvent.click(screen.getByRole('button', { name: /review vote/i }));

    const dialog = screen.getByRole('dialog', { name: 'Review vote' });
    expect(
      within(dialog).getByText(/cannot change or recast this vote here/i),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        /board can correct the recorded vote after voting closes/i,
      ),
    ).toBeVisible();
    expect(
      within(dialog).queryByText(/cannot be changed or recovered/i),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /cast final vote/i }));

    const receiptHeading = await screen.findByRole('heading', {
      name: /vote received for 101 example street/i,
    });
    const receipt = receiptHeading.closest('article');
    expect(receipt).not.toBeNull();
    expect(within(receipt!).getByText('Member meeting')).toBeVisible();
    expect(within(receipt!).queryByText(/^yes$/i)).toBeNull();
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

  it('labels an existing motion receipt Vote recorded without disclosing a choice', () => {
    render(
      <VoteManager
        items={[
          {
            ...motion,
            lots: motion.lots.map((lot) => ({ ...lot, hasCast: true })),
          },
        ]}
      />,
    );

    const receiptHeading = screen.getByRole('heading', {
      name: 'Vote recorded',
    });
    const receipt = receiptHeading.closest('article');
    expect(receipt).not.toBeNull();
    expect(within(receipt!).getByText('101 Example Street')).toBeVisible();
    expect(within(receipt!).getByText('Member meeting')).toBeVisible();
    expect(within(receipt!).queryByText(/^(yes|no|abstain)$/i)).toBeNull();
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

  it('keeps keyboard focus modal and restores it after Escape', async () => {
    render(<VoteManager items={[election]} />);
    fireEvent.click(screen.getByLabelText('Candidate One'));
    const review = screen.getByRole('button', { name: /review ballot/i });
    fireEvent.click(review);

    const dialog = screen.getByRole('dialog', { name: 'Review ballot' });
    const goBack = within(dialog).getByRole('button', { name: 'Go back' });
    const cast = within(dialog).getByRole('button', {
      name: 'Cast final ballot',
    });
    await waitFor(() => expect(goBack).toHaveFocus());

    cast.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(goBack).toHaveFocus();
    goBack.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(cast).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(review).toHaveFocus();
  });

  it('disables the ballot controls behind an open confirmation', () => {
    render(<VoteManager items={[election]} />);
    fireEvent.click(screen.getByLabelText('Candidate One'));
    const review = screen.getByRole('button', { name: /review ballot/i });
    fireEvent.click(review);

    expect(screen.getByLabelText('Candidate One')).toBeDisabled();
    expect(screen.getByLabelText(/vote as an owner/i)).toBeDisabled();
    expect(review).toBeDisabled();
  });

  it('reviews election selections with the selected owner provenance', () => {
    render(<VoteManager items={[election]} />);
    fireEvent.click(screen.getByLabelText('Candidate One'));
    fireEvent.click(screen.getByRole('button', { name: /review ballot/i }));

    const dialog = screen.getByRole('dialog', { name: 'Review ballot' });
    expect(within(dialog).getByText('Candidate One')).toBeVisible();
    expect(within(dialog).getByText(/voting as owner one/i)).toBeVisible();
  });

  it('reviews the motion choice with proxy provenance', () => {
    render(<VoteManager items={[motion]} />);
    fireEvent.click(screen.getByLabelText('No'));
    fireEvent.click(screen.getByLabelText(/vote by proxy/i));
    fireEvent.click(screen.getByRole('button', { name: /review vote/i }));

    const dialog = screen.getByRole('dialog', { name: 'Review vote' });
    expect(within(dialog).getByText(/choice: no/i)).toBeVisible();
    expect(
      within(dialog).getByText(/voting by proxy for 102 example street/i),
    ).toBeVisible();
  });

  it('disables sibling voting cards until the active review is cancelled', async () => {
    render(<VoteManager items={[election, motion]} />);
    const siblingChoice = screen.getByLabelText('Yes');
    const siblingReview = screen.getByRole('button', { name: /review vote/i });
    fireEvent.click(screen.getByLabelText('Candidate One'));
    fireEvent.click(screen.getByRole('button', { name: /review ballot/i }));

    expect(siblingChoice).toBeDisabled();
    expect(siblingReview).toBeDisabled();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(siblingChoice).toBeEnabled());
    expect(siblingReview).toBeDisabled();

    fireEvent.click(siblingChoice);
    expect(siblingReview).toBeEnabled();
  });
});
