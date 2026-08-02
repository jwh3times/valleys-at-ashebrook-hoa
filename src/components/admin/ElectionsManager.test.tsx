import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ElectionsManager from './ElectionsManager';
import * as admin from '../../lib/admin';
import { ELECTION_STATUSES } from '../../lib/types';
import type {
  ElectionDetail,
  CandidateSummary,
  PropertyWithOwners,
} from '../../lib/types';

vi.mock('../../lib/admin');

const mocked = vi.mocked(admin);

beforeEach(() => {
  vi.resetAllMocks();
  mocked.fetchProperties.mockResolvedValue([]);
  mocked.fetchBoardPeople.mockResolvedValue([]);
});

function candidate(
  overrides: Partial<CandidateSummary> = {},
): CandidateSummary {
  return {
    id: 'c1',
    fullName: 'Alice',
    boardPersonId: null,
    statementMd: null,
    sequence: 1,
    votes: null,
    won: false,
    withdrawn: false,
    ...overrides,
  };
}

function property(
  overrides: Partial<PropertyWithOwners> = {},
): PropertyWithOwners {
  return {
    id: 'p1',
    address: '100 Main St',
    unit: null,
    status: 'active',
    notes: null,
    voteWeight: 1,
    owners: [],
    ...overrides,
  };
}

function election(overrides: Partial<ElectionDetail> = {}): ElectionDetail {
  return {
    id: 'e1',
    meetingId: null,
    title: 'Board Election 2026',
    seats: 2,
    electionDate: '2026-01-15',
    source: 'recorded',
    status: 'draft',
    visibility: 'board',
    candidates: [],
    turnout: {
      ballotsCast: 0,
      weightCast: 0,
      eligibleCount: 0,
      eligibleWeight: 0,
    },
    ballots: [],
    ...overrides,
  };
}

describe('ElectionsManager', () => {
  it('shows an empty state when no elections exist', async () => {
    mocked.fetchElections.mockResolvedValue([]);
    render(<ElectionsManager />);
    expect(await screen.findByText(/no elections yet/i)).toBeInTheDocument();
  });

  it('groups elections by status with drafts first', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({ id: 'e-void', title: 'Void one', status: 'void' }),
      election({
        id: 'e-certified',
        title: 'Certified one',
        status: 'certified',
      }),
      election({ id: 'e-closed', title: 'Closed one', status: 'closed' }),
      election({ id: 'e-draft', title: 'Draft one', status: 'draft' }),
    ]);
    render(<ElectionsManager />);
    await screen.findByText('Draft one');

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Draft', 'Closed', 'Certified', 'Void']);

    // Pin real DOM order, not just heading presence: each election's title
    // must land in the right group, in the right order. Read titles from
    // .admin-row-title specifically — a plain textContent scan would false-
    // match "Void" against the Void action button rendered on the Closed
    // group's own row.
    const titles = Array.from(
      document.querySelectorAll('.panel-list .admin-row-title'),
    ).map((el) => el.textContent);
    expect(titles).toEqual([
      'Draft one',
      'Closed one',
      'Certified one',
      'Void one',
    ]);
  });

  it('adds an election and reloads', async () => {
    mocked.fetchElections.mockResolvedValue([]);
    mocked.saveElection.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await screen.findByText(/no elections yet/i);

    await userEvent.type(
      screen.getByLabelText(/^title$/i),
      'Board Election 2026',
    );
    const dateInput = screen.getByLabelText(/^election date$/i);
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2026-01-15');
    await userEvent.click(
      screen.getByRole('button', { name: /^add election$/i }),
    );

    await waitFor(() =>
      expect(mocked.saveElection).toHaveBeenCalledWith(
        {
          title: 'Board Election 2026',
          seats: 1,
          electionDate: '2026-01-15',
          meetingId: null,
          visibility: 'board',
        },
        undefined,
      ),
    );
    expect(await screen.findByText(/election added/i)).toBeInTheDocument();
  });

  it('closing an election calls closeElection', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({ id: 'e1', title: 'Board Election 2026', status: 'draft' }),
    ]);
    mocked.closeElection.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await screen.findByText('Board Election 2026');

    await userEvent.click(
      screen.getByRole('button', { name: /close board election 2026/i }),
    );

    await waitFor(() =>
      expect(mocked.closeElection).toHaveBeenCalledWith('e1'),
    );
    expect(await screen.findByText(/election closed/i)).toBeInTheDocument();
  });

  it('certifying collects a term start per winner and calls certifyElection with them', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        id: 'e1',
        title: 'Board Election 2026',
        status: 'closed',
        candidates: [
          candidate({ id: 'c1', fullName: 'Alice', sequence: 1 }),
          candidate({ id: 'c2', fullName: 'Bob', sequence: 2 }),
        ],
      }),
    ]);
    mocked.certifyElection.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await screen.findByText('Board Election 2026');

    await userEvent.click(
      screen.getByRole('button', { name: /candidates & ballots/i }),
    );
    await userEvent.click(screen.getByLabelText(/winner — alice/i));
    await userEvent.click(screen.getByLabelText(/winner — bob/i));
    await userEvent.type(
      screen.getByLabelText(/term start — alice/i),
      '2026-02-01',
    );
    await userEvent.type(
      screen.getByLabelText(/term start — bob/i),
      '2027-02-01',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /^certify election$/i }),
    );

    await waitFor(() =>
      expect(mocked.certifyElection).toHaveBeenCalledWith('e1', [
        {
          candidateId: 'c1',
          termStart: '2026-02-01',
          termEnd: null,
          title: null,
        },
        {
          candidateId: 'c2',
          termStart: '2027-02-01',
          termEnd: null,
          title: null,
        },
      ]),
    );
  });

  it('certifying with no winner selected is refused before any request', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        id: 'e1',
        title: 'Board Election 2026',
        status: 'closed',
        candidates: [candidate({ id: 'c1', fullName: 'Alice' })],
      }),
    ]);
    render(<ElectionsManager />);
    await screen.findByText('Board Election 2026');

    await userEvent.click(
      screen.getByRole('button', { name: /candidates & ballots/i }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: /^certify election$/i }),
    );

    expect(mocked.certifyElection).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/select at least one winner/i),
    ).toBeInTheDocument();
  });

  it('recording tallies calls setTallies with one entry per candidate', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        id: 'e1',
        title: 'Board Election 2026',
        status: 'closed',
        candidates: [
          candidate({ id: 'c1', fullName: 'Alice' }),
          candidate({ id: 'c2', fullName: 'Bob' }),
        ],
      }),
    ]);
    mocked.setTallies.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await screen.findByText('Board Election 2026');

    await userEvent.click(
      screen.getByRole('button', { name: /candidates & ballots/i }),
    );
    const aliceTally = screen.getByLabelText(/tally — alice/i);
    await userEvent.clear(aliceTally);
    await userEvent.type(aliceTally, '42');
    const bobTally = screen.getByLabelText(/tally — bob/i);
    await userEvent.clear(bobTally);
    await userEvent.type(bobTally, '17');
    await userEvent.click(
      screen.getByRole('button', { name: /^save tallies$/i }),
    );

    await waitFor(() =>
      expect(mocked.setTallies).toHaveBeenCalledWith('e1', [
        { candidateId: 'c1', votes: 42 },
        { candidateId: 'c2', votes: 17 },
      ]),
    );
  });

  it('declining the delete confirmation does not call deleteElection, and shows no success banner', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mocked.fetchElections.mockResolvedValue([
      election({ id: 'e1', title: 'Board Election 2026', status: 'draft' }),
    ]);
    render(<ElectionsManager />);
    await screen.findByText('Board Election 2026');

    await userEvent.click(
      screen.getByRole('button', { name: /delete board election 2026/i }),
    );

    expect(confirmSpy).toHaveBeenCalled();
    expect(mocked.deleteElection).not.toHaveBeenCalled();
    expect(screen.queryByText(/election deleted/i)).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('surfaces the 409 text when certifying an uncertified-state election', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        id: 'e1',
        title: 'Board Election 2026',
        status: 'closed',
        candidates: [candidate({ id: 'c1', fullName: 'Alice' })],
      }),
    ]);
    mocked.certifyElection.mockRejectedValue(
      new Error('Close the election before certifying it'),
    );
    render(<ElectionsManager />);
    await screen.findByText('Board Election 2026');

    await userEvent.click(
      screen.getByRole('button', { name: /candidates & ballots/i }),
    );
    await userEvent.click(screen.getByLabelText(/winner — alice/i));
    await userEvent.type(
      screen.getByLabelText(/term start — alice/i),
      '2026-02-01',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /^certify election$/i }),
    );

    expect(
      await screen.findByText(/close the election before certifying it/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/409/)).not.toBeInTheDocument();
  });

  it('the form offers no status control', async () => {
    mocked.fetchElections.mockResolvedValue([]);
    render(<ElectionsManager />);
    await screen.findByText(/no elections yet/i);

    const form = screen
      .getByRole('button', { name: /^add election$/i })
      .closest('form') as HTMLElement;
    expect(within(form).queryByLabelText(/status/i)).not.toBeInTheDocument();
    expect(within(form).queryByText(/^status$/i)).not.toBeInTheDocument();

    // Guard against a status control smuggled in without a matching label: no
    // combobox in the form may offer any election status as an option.
    for (const select of within(form).queryAllByRole('combobox')) {
      const optionText = within(select as HTMLElement)
        .getAllByRole('option')
        .map((o) => o.textContent)
        .join(' ')
        .toLowerCase();
      for (const status of ELECTION_STATUSES) {
        expect(optionText).not.toContain(status);
      }
    }
  });

  it('editing an existing election calls saveElection with its id', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({ id: 'e1', title: 'Board Election 2026', status: 'draft' }),
    ]);
    mocked.saveElection.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const titleInput = screen.getByLabelText(/^title$/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Updated Board Election');
    await userEvent.click(
      screen.getByRole('button', { name: /save election/i }),
    );

    await waitFor(() =>
      expect(mocked.saveElection).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Updated Board Election' }),
        'e1',
      ),
    );
  });

  it('adding a candidate calls saveCandidate with the election id and candidate fields, and no id', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({ id: 'e1', title: 'Board Election 2026', status: 'draft' }),
    ]);
    mocked.saveCandidate.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await screen.findByText('Board Election 2026');

    await userEvent.click(
      screen.getByRole('button', { name: /candidates & ballots/i }),
    );
    await userEvent.type(screen.getByLabelText(/^full name$/i), 'Alice');
    await userEvent.click(
      screen.getByRole('button', { name: /^add candidate$/i }),
    );

    await waitFor(() =>
      expect(mocked.saveCandidate).toHaveBeenCalledWith(
        'e1',
        { fullName: 'Alice', statementMd: null, boardPersonId: null },
        undefined,
      ),
    );
  });

  it('editing an existing candidate calls saveCandidate with its id', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        id: 'e1',
        title: 'Board Election 2026',
        status: 'draft',
        candidates: [candidate({ id: 'c1', fullName: 'Alice' })],
      }),
    ]);
    mocked.saveCandidate.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await screen.findByText('Board Election 2026');

    await userEvent.click(
      screen.getByRole('button', { name: /candidates & ballots/i }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: /edit candidate alice/i }),
    );
    const nameInput = screen.getByLabelText(/^full name$/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Alice Updated');
    await userEvent.click(
      screen.getByRole('button', { name: /^save candidate$/i }),
    );

    await waitFor(() =>
      expect(mocked.saveCandidate).toHaveBeenCalledWith(
        'e1',
        { fullName: 'Alice Updated', statementMd: null, boardPersonId: null },
        'c1',
      ),
    );
  });

  it('recording ballots calls setBallots with weight, viaProxy, and castByOwnerId per checked property', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({ id: 'e1', title: 'Board Election 2026', status: 'closed' }),
    ]);
    mocked.fetchProperties.mockResolvedValue([
      property({ id: 'p1', address: '100 Main St', owners: [] }),
      property({
        id: 'p2',
        address: '200 Oak St',
        owners: [
          {
            id: 'o2',
            propertyId: 'p2',
            fullName: 'Owner Two',
            phone: null,
            email: null,
            status: 'active',
            notes: null,
          },
        ],
      }),
    ]);
    mocked.setBallots.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await screen.findByText('Board Election 2026');

    await userEvent.click(
      screen.getByRole('button', { name: /candidates & ballots/i }),
    );
    // p1: returned a ballot, weight left untouched, no owner to cast by.
    await userEvent.click(
      screen.getByLabelText(/ballot returned — 100 main st/i),
    );
    // p2: returned a ballot, weight explicitly overridden, cast by its owner,
    // via proxy.
    await userEvent.click(
      screen.getByLabelText(/ballot returned — 200 oak st/i),
    );
    await userEvent.type(
      screen.getByLabelText(/weight override.*200 oak st/i),
      '3',
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/cast by — 200 oak st/i),
      'o2',
    );
    await userEvent.click(screen.getByLabelText(/via proxy/i));
    await userEvent.click(
      screen.getByRole('button', { name: /^save ballots$/i }),
    );

    await waitFor(() =>
      expect(mocked.setBallots).toHaveBeenCalledWith('e1', [
        {
          propertyId: 'p1',
          weight: undefined,
          viaProxy: false,
          castByOwnerId: null,
        },
        {
          propertyId: 'p2',
          weight: 3,
          viaProxy: true,
          castByOwnerId: 'o2',
        },
      ]),
    );
  });

  it('typing 0 seats surfaces the server error instead of silently defaulting to 1', async () => {
    mocked.fetchElections.mockResolvedValue([]);
    mocked.saveElection.mockRejectedValue(
      new Error('seats must be at least 1'),
    );
    render(<ElectionsManager />);
    await screen.findByText(/no elections yet/i);

    await userEvent.type(
      screen.getByLabelText(/^title$/i),
      'Board Election 2026',
    );
    const seatsInput = screen.getByLabelText(/^seats$/i);
    await userEvent.clear(seatsInput);
    await userEvent.type(seatsInput, '0');
    const dateInput = screen.getByLabelText(/^election date$/i);
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2026-01-15');
    await userEvent.click(
      screen.getByRole('button', { name: /^add election$/i }),
    );

    await waitFor(() =>
      expect(mocked.saveElection).toHaveBeenCalledWith(
        expect.objectContaining({ seats: 0 }),
        undefined,
      ),
    );
    expect(
      await screen.findByText(/seats must be at least 1/i),
    ).toBeInTheDocument();
  });
});
