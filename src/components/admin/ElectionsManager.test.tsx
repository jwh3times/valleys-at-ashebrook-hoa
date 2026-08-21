import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  within,
  waitFor,
  fireEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ElectionsManager from './ElectionsManager';
import * as admin from '../../lib/admin';
import * as content from '../../lib/content';
import { ELECTION_STATUSES } from '../../lib/types';
import type {
  ElectionDetail,
  CandidateSummary,
  PropertyWithOwners,
} from '../../lib/types';

vi.mock('../../lib/admin');
vi.mock('../../lib/content');

const mocked = vi.mocked(admin);
const mockedContent = vi.mocked(content);

beforeEach(() => {
  vi.resetAllMocks();
  mocked.fetchProperties.mockResolvedValue([]);
  mocked.fetchMeetingRosterPeople.mockResolvedValue([]);
  mocked.fetchRosterPeople.mockResolvedValue([]);
  mocked.fetchProxies.mockResolvedValue([]);
  mockedContent.fetchSiteSettings.mockResolvedValue({
    siteName: 'The Valleys at Ashebrook Residents',
    tagline: '',
    contactEmail: '',
    welcomeHeading: '',
    welcomeBody: '',
    officialMode: true,
    liveVotingEnabled: true,
    disclaimerText: '',
    aboutBody: '',
  });
});

function candidate(
  overrides: Partial<CandidateSummary> = {},
): CandidateSummary {
  return {
    id: 'c1',
    fullName: 'Alice',
    personId: null,
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
      eligibilityFrozen: false,
    },
    eligibleProperties: [],
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

  it('keeps draft and open elections in Active and settled elections in History', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({ id: 'e-void', title: 'Void one', status: 'void' }),
      election({
        id: 'e-certified',
        title: 'Certified one',
        status: 'certified',
      }),
      election({ id: 'e-closed', title: 'Closed one', status: 'closed' }),
      election({ id: 'e-open', title: 'Open one', status: 'open' }),
      election({ id: 'e-draft', title: 'Draft one', status: 'draft' }),
    ]);
    render(<ElectionsManager />);
    await screen.findByText('Draft one');

    expect(screen.getByText('Open one')).toBeInTheDocument();
    expect(screen.queryByText('Closed one')).not.toBeInTheDocument();
    expect(screen.queryByText('Certified one')).not.toBeInTheDocument();
    expect(screen.queryByText('Void one')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^history$/i }));

    expect(screen.queryByText('Draft one')).not.toBeInTheDocument();
    expect(screen.queryByText('Open one')).not.toBeInTheDocument();
    expect(screen.getByText('Closed one')).toBeInTheDocument();
    expect(screen.getByText('Certified one')).toBeInTheDocument();
    expect(screen.getByText('Void one')).toBeInTheDocument();

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['Closed', 'Certified', 'Void']);
  });

  it('offers Recorded and Conducted election sources on create', async () => {
    mocked.fetchElections.mockResolvedValue([]);
    render(<ElectionsManager />);
    await screen.findByText(/no elections yet/i);

    const source = screen.getByLabelText(/^election type$/i);
    expect(
      within(source).getByRole('option', { name: 'Recorded' }),
    ).toHaveValue('recorded');
    expect(
      within(source).getByRole('option', { name: 'Conducted' }),
    ).toHaveValue('conducted');
  });

  it('reconciles conducted Open and Close controls from successive server states', async () => {
    const draft = election({
      id: 'e1',
      title: 'Conducted election',
      source: 'conducted',
    });
    mocked.fetchElections
      .mockResolvedValueOnce([draft])
      .mockResolvedValueOnce([{ ...draft, status: 'open' }])
      .mockResolvedValueOnce([{ ...draft, status: 'closed' }]);
    mocked.openElection.mockResolvedValue(undefined);
    mocked.closeElection.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await screen.findByText('Conducted election');

    await userEvent.click(
      screen.getByRole('button', { name: /open conducted election/i }),
    );

    await waitFor(() => expect(mocked.openElection).toHaveBeenCalledWith('e1'));
    expect(
      await screen.findByRole('button', { name: /close conducted election/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /open conducted election/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: /close conducted election/i }),
    );
    await waitFor(() =>
      expect(mocked.closeElection).toHaveBeenCalledWith('e1'),
    );
    expect(screen.queryByText('Conducted election')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^history$/i }));
    expect(await screen.findByText('Conducted election')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /close conducted election/i }),
    ).not.toBeInTheDocument();
  });

  it('surfaces a readable election lifecycle error without falsely opening', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        id: 'e1',
        title: 'Conducted election',
        source: 'conducted',
      }),
    ]);
    mocked.openElection.mockRejectedValue(
      new Error('Official mode and live voting must both be enabled.'),
    );
    render(<ElectionsManager />);
    await screen.findByText('Conducted election');

    await userEvent.click(
      screen.getByRole('button', { name: /open conducted election/i }),
    );

    expect(
      await screen.findByText(/official mode and live voting/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /open conducted election/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /close conducted election/i }),
    ).not.toBeInTheDocument();
    expect(mocked.fetchElections).toHaveBeenCalledTimes(1);
  });

  it('shows turnout only while a conducted election is open', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        title: 'Open conducted election',
        source: 'conducted',
        status: 'open',
        candidates: [candidate({ votes: 42 })],
        turnout: {
          ballotsCast: 2,
          weightCast: 4,
          eligibleCount: 5,
          eligibleWeight: 8,
          eligibilityFrozen: true,
        },
      }),
    ]);
    render(<ElectionsManager />);
    const title = await screen.findByText('Open conducted election');
    const card = title.closest('.panel-card') as HTMLElement;

    expect(within(card).getByText(/2 of 5 ballots cast/i)).toBeInTheDocument();
    expect(within(card).getByText(/4 of 8 weight cast/i)).toBeInTheDocument();
    expect(within(card).queryByText(/42 votes/i)).not.toBeInTheDocument();

    await userEvent.click(
      within(card).getByRole('button', { name: /details/i }),
    );
    expect(
      within(card).queryByLabelText(/tally — alice/i),
    ).not.toBeInTheDocument();
    expect(
      within(card).queryByRole('button', { name: /save tallies/i }),
    ).not.toBeInTheDocument();
    expect(
      within(card).queryByRole('button', { name: /save ballots/i }),
    ).not.toBeInTheDocument();
  });

  it('marks an open conducted election paused globally without removing Close', async () => {
    mockedContent.fetchSiteSettings.mockResolvedValueOnce({
      siteName: 'The Valleys at Ashebrook Residents',
      tagline: '',
      contactEmail: '',
      welcomeHeading: '',
      welcomeBody: '',
      officialMode: true,
      liveVotingEnabled: false,
      disclaimerText: '',
      aboutBody: '',
    });
    mocked.fetchElections.mockResolvedValue([
      election({
        title: 'Paused election',
        source: 'conducted',
        status: 'open',
      }),
    ]);
    render(<ElectionsManager />);
    const title = await screen.findByText('Paused election');
    const card = title.closest('.panel-card') as HTMLElement;

    expect(within(card).getByText('Paused globally')).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: /close paused election/i }),
    ).toBeInTheDocument();
  });

  it('marks an open conducted election paused when official mode is off', async () => {
    mockedContent.fetchSiteSettings.mockResolvedValueOnce({
      siteName: 'The Valleys at Ashebrook Residents',
      tagline: '',
      contactEmail: '',
      welcomeHeading: '',
      welcomeBody: '',
      officialMode: false,
      liveVotingEnabled: true,
      disclaimerText: '',
      aboutBody: '',
    });
    mocked.fetchElections.mockResolvedValue([
      election({
        title: 'Official mode paused election',
        source: 'conducted',
        status: 'open',
      }),
    ]);
    render(<ElectionsManager />);
    const title = await screen.findByText('Official mode paused election');
    const card = title.closest('.panel-card') as HTMLElement;

    expect(within(card).getByText('Paused globally')).toBeInTheDocument();
    expect(
      within(card).getByRole('button', {
        name: /close official mode paused election/i,
      }),
    ).toBeInTheDocument();
  });

  it('does not offer an add-candidate form on a closed recorded election', async () => {
    // The board used to get a working-looking form here; POST
    // /api/admin/candidates refuses a non-draft election with 409.
    mocked.fetchElections.mockResolvedValue([
      election({
        title: 'Closed recorded election',
        source: 'recorded',
        status: 'closed',
        candidates: [candidate({ fullName: 'Alice' })],
      }),
    ]);
    render(<ElectionsManager />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    const title = screen.getByText('Closed recorded election');
    const card = title.closest('.panel-card') as HTMLElement;
    await userEvent.click(
      within(card).getByRole('button', { name: /details/i }),
    );

    expect(within(card).queryByText('Add candidate')).not.toBeInTheDocument();
    // The rest of the record is still editable, so this is not the panel
    // simply having gone read-only.
    expect(
      within(card).getByRole('button', {
        name: /edit closed recorded election/i,
      }),
    ).toBeInTheDocument();
  });

  it('shows closed conducted totals and the frozen eligible denominator read-only', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        title: 'Closed conducted election',
        source: 'conducted',
        status: 'closed',
        candidates: [candidate({ votes: 6 })],
        turnout: {
          ballotsCast: 3,
          weightCast: 6,
          eligibleCount: 4,
          eligibleWeight: 9,
          eligibilityFrozen: true,
        },
      }),
    ]);
    render(<ElectionsManager />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    const title = screen.getByText('Closed conducted election');
    const card = title.closest('.panel-card') as HTMLElement;
    await userEvent.click(
      within(card).getByRole('button', { name: /details/i }),
    );

    expect(within(card).getByText(/^alice$/i)).toBeInTheDocument();
    expect(within(card).getByText(/6 votes/i)).toBeInTheDocument();
    expect(within(card).getByText(/9 eligible weight/i)).toBeInTheDocument();
    expect(
      within(card).queryByLabelText(/tally — alice/i),
    ).not.toBeInTheDocument();
    expect(
      within(card).queryByRole('button', { name: /save ballots/i }),
    ).not.toBeInTheDocument();
  });

  it('shows eligibility and turnout provenance without a selection field', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        title: 'Provenance election',
        source: 'conducted',
        status: 'open',
        eligibleProperties: [
          { propertyId: 'p1', address: '100 Main St', weight: 2 },
          { propertyId: 'p2', address: '102 Main St', weight: 3 },
        ],
        ballots: [
          {
            propertyId: 'p1',
            address: '100 Main St',
            weight: 2,
            viaProxy: false,
            castByOwnerId: null,
            proxyId: null,
          },
        ],
      }),
    ]);
    render(<ElectionsManager />);
    const title = await screen.findByText('Provenance election');
    const card = title.closest('.panel-card') as HTMLElement;
    await userEvent.click(
      within(card).getByRole('button', { name: /details/i }),
    );

    const eligibility = within(card)
      .getByText('Eligibility register')
      .closest('.panel-card') as HTMLElement;
    expect(within(eligibility).getByText('100 Main St')).toBeInTheDocument();
    expect(within(eligibility).getByText('102 Main St')).toBeInTheDocument();
    expect(within(eligibility).getByText(/weight 2/i)).toBeInTheDocument();

    const turnout = within(card)
      .getByText('Turnout register')
      .closest('.panel-card') as HTMLElement;
    expect(within(turnout).getByText('100 Main St')).toBeInTheDocument();
    expect(within(turnout).getByText(/weight 2/i)).toBeInTheDocument();
    expect(within(turnout).queryByText(/selection/i)).not.toBeInTheDocument();
    expect(within(turnout).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(turnout).queryByRole('radio')).not.toBeInTheDocument();
  });

  it('retains tally and ballot editors for recorded elections', async () => {
    mocked.fetchProperties.mockResolvedValue([property()]);
    mocked.fetchElections.mockResolvedValue([
      election({
        title: 'Recorded election',
        status: 'closed',
        candidates: [candidate()],
      }),
    ]);
    render(<ElectionsManager />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    const title = screen.getByText('Recorded election');
    const card = title.closest('.panel-card') as HTMLElement;
    await userEvent.click(
      within(card).getByRole('button', { name: /details/i }),
    );

    expect(within(card).getByLabelText(/tally — alice/i)).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: /save tallies/i }),
    ).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: /save ballots/i }),
    ).toBeInTheDocument();
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
          source: 'recorded',
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

  it('certifying collects the #218 winner shape and calls certifyElection with it', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        id: 'e1',
        title: 'Board Election 2026',
        status: 'closed',
        candidates: [candidate({ id: 'c1', fullName: 'Alice', sequence: 1 })],
      }),
    ]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'lot-1',
        address: '1 Ashebrook Lane',
        unit: null,
        status: 'active' as const,
        voteWeight: 1,
        notes: null,
        owners: [],
      },
    ]);
    mocked.fetchRosterPeople.mockResolvedValue([
      { partyId: 'per-1', displayName: 'Alice Person' },
    ]);
    mocked.certifyElection.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
    await userEvent.click(screen.getByLabelText(/winner — alice/i));
    await userEvent.selectOptions(
      screen.getByLabelText(/person — alice/i),
      'per-1',
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/qualifying lot — alice/i),
      'lot-1',
    );
    await userEvent.type(
      screen.getByLabelText(/start day — alice/i),
      '2026-02-01',
    );
    await userEvent.type(
      screen.getByLabelText(/scheduled end day — alice/i),
      '2027-02-01',
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/office \(optional\) — alice/i),
      'president',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /^certify election$/i }),
    );

    await waitFor(() =>
      expect(mocked.certifyElection).toHaveBeenCalledWith('e1', [
        {
          candidateId: 'c1',
          personId: 'per-1',
          qualifyingLotId: 'lot-1',
          startDay: '2026-02-01',
          scheduledEndDay: '2027-02-01',
          office: 'president',
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
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
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
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
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

  it('leaving a tally blank omits that candidate from the payload rather than recording a zero', async () => {
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
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
    // Alice gets a real tally; Bob's field is left untouched (blank), the
    // same as a board member who has not yet counted Bob's ballots.
    const aliceTally = screen.getByLabelText(/tally — alice/i);
    await userEvent.clear(aliceTally);
    await userEvent.type(aliceTally, '42');
    await userEvent.click(
      screen.getByRole('button', { name: /^save tallies$/i }),
    );

    await waitFor(() =>
      expect(mocked.setTallies).toHaveBeenCalledWith('e1', [
        { candidateId: 'c1', votes: 42 },
      ]),
    );
    // Bob must be absent from the payload entirely — not present with
    // votes: 0 — since the server restores NULL ("not recorded") for any
    // candidate it doesn't see in `entries`.
    const [, entries] = mocked.setTallies.mock.calls[0];
    expect(entries.some((e) => e.candidateId === 'c2')).toBe(false);
  });

  it('a non-numeric tally surfaces the server error instead of being silently recorded as zero', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        id: 'e1',
        title: 'Board Election 2026',
        status: 'closed',
        candidates: [candidate({ id: 'c1', fullName: 'Alice' })],
      }),
    ]);
    mocked.setTallies.mockRejectedValue(
      new Error('votes must be a non-negative integer'),
    );
    render(<ElectionsManager />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
    const aliceTally = screen.getByLabelText(
      /tally — alice/i,
    ) as HTMLInputElement;
    // <input type="number"> sanitizes any non-numeric string to "" on both
    // typing and direct value assignment — jsdom does this the same as real
    // browsers — so a literal "1o" can never land in this field through
    // normal interaction. Force the DOM node's type to "text" for this one
    // change so the test can still exercise the client's Number(...) mapping
    // and confirm the server's own validation is what actually catches a bad
    // value, rather than relying entirely on the browser to prevent it.
    aliceTally.type = 'text';
    fireEvent.change(aliceTally, { target: { value: '1o' } });
    await userEvent.click(
      screen.getByRole('button', { name: /^save tallies$/i }),
    );

    await waitFor(() =>
      expect(mocked.setTallies).toHaveBeenCalledWith('e1', [
        { candidateId: 'c1', votes: NaN },
      ]),
    );
    expect(
      await screen.findByText(/votes must be a non-negative integer/i),
    ).toBeInTheDocument();
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
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'lot-1',
        address: '1 Ashebrook Lane',
        unit: null,
        status: 'active' as const,
        voteWeight: 1,
        notes: null,
        owners: [],
      },
    ]);
    mocked.certifyElection.mockRejectedValue(
      new Error('Close the election before certifying it'),
    );
    render(<ElectionsManager />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
    await userEvent.click(screen.getByLabelText(/winner — alice/i));
    await userEvent.selectOptions(
      screen.getByLabelText(/qualifying lot — alice/i),
      'lot-1',
    );
    await userEvent.type(
      screen.getByLabelText(/start day — alice/i),
      '2026-02-01',
    );
    await userEvent.type(
      screen.getByLabelText(/scheduled end day — alice/i),
      '2027-02-01',
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

    await userEvent.click(
      screen.getByRole('button', { name: /edit board election 2026/i }),
    );
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

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
    await userEvent.type(screen.getByLabelText(/^full name$/i), 'Alice');
    await userEvent.click(
      screen.getByRole('button', { name: /^add candidate$/i }),
    );

    await waitFor(() =>
      expect(mocked.saveCandidate).toHaveBeenCalledWith(
        'e1',
        { fullName: 'Alice', statementMd: null, personId: null },
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

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
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
        { fullName: 'Alice Updated', statementMd: null, personId: null },
        'c1',
      ),
    );
  });

  it('recording ballots calls setBallots with weight and castByOwnerId per checked property', async () => {
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
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
    // p1: returned a ballot, weight left untouched, no owner to cast by.
    await userEvent.click(
      screen.getByLabelText(/ballot returned — 100 main st/i),
    );
    // p2: returned a ballot, weight explicitly overridden, cast by its owner.
    // proxyId is not yet settable through this form — see Task 6's picker —
    // so it always sends null here.
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
    await userEvent.click(
      screen.getByRole('button', { name: /^save ballots$/i }),
    );

    await waitFor(() =>
      expect(mocked.setBallots).toHaveBeenCalledWith('e1', [
        {
          propertyId: 'p1',
          weight: undefined,
          proxyId: null,
          castByOwnerId: null,
        },
        {
          propertyId: 'p2',
          weight: 3,
          proxyId: null,
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

  it('selecting a proxy for a ballot sends its id and clears castByOwnerId', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({ id: 'e1', title: 'Board Election 2026', status: 'closed' }),
    ]);
    mocked.fetchProperties.mockResolvedValue([
      property({
        id: 'p1',
        address: '100 Main St',
        owners: [
          {
            id: 'o1',
            propertyId: 'p1',
            fullName: 'Jane Doe',
            phone: null,
            email: null,
            status: 'active',
            notes: null,
          },
        ],
      }),
    ]);
    mocked.fetchProxies.mockResolvedValue([
      {
        id: 'px1',
        propertyId: 'p1',
        address: '100 Main St',
        grantorOwnerId: 'o1',
        grantorName: 'Jane Doe',
        holderName: 'Proxy Holder',
        holderOwnerId: null,
        holderOwnerName: null,
        meetingId: null,
        electionId: 'e1',
      },
    ]);
    mocked.setBallots.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
    await userEvent.click(
      screen.getByLabelText(/ballot returned — 100 main st/i),
    );
    const castBySelect = screen.getByLabelText(/cast by — 100 main st/i);
    await userEvent.selectOptions(castBySelect, 'o1');
    expect(castBySelect).toHaveValue('o1');

    await userEvent.selectOptions(
      screen.getByLabelText(/proxy — 100 main st/i),
      'px1',
    );

    // Choosing the proxy clears AND disables the cast-by select.
    expect(castBySelect).toHaveValue('');
    expect(castBySelect).toBeDisabled();

    await userEvent.click(
      screen.getByRole('button', { name: /^save ballots$/i }),
    );

    await waitFor(() =>
      expect(mocked.setBallots).toHaveBeenCalledWith('e1', [
        {
          propertyId: 'p1',
          weight: undefined,
          proxyId: 'px1',
          castByOwnerId: null,
        },
      ]),
    );
  });

  it("the ballot picker offers a proxy scoped only to the election's meeting, not the election itself", async () => {
    mocked.fetchElections.mockResolvedValue([
      election({
        id: 'e1',
        title: 'Board Election 2026',
        status: 'closed',
        meetingId: 'm1',
      }),
    ]);
    mocked.fetchProperties.mockResolvedValue([
      property({ id: 'p1', address: '100 Main St', owners: [] }),
    ]);
    mocked.fetchProxies.mockResolvedValue([
      {
        id: 'px1',
        propertyId: 'p1',
        address: '100 Main St',
        grantorOwnerId: 'o1',
        grantorName: 'Jane Doe',
        holderName: 'Proxy Holder',
        holderOwnerId: null,
        holderOwnerName: null,
        // Scoped ONLY to the meeting the election was held at — not to the
        // election id itself — which is the fallback branch this test pins.
        meetingId: 'm1',
        electionId: null,
      },
    ]);
    mocked.setBallots.mockResolvedValue(undefined);
    render(<ElectionsManager />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
    await userEvent.click(
      screen.getByLabelText(/ballot returned — 100 main st/i),
    );

    const proxySelect = screen.getByLabelText(/proxy — 100 main st/i);
    expect(
      within(proxySelect).getByText(/via proxy: proxy holder/i),
    ).toBeInTheDocument();
    await userEvent.selectOptions(proxySelect, 'px1');

    await userEvent.click(
      screen.getByRole('button', { name: /^save ballots$/i }),
    );

    await waitFor(() =>
      expect(mocked.setBallots).toHaveBeenCalledWith('e1', [
        expect.objectContaining({ propertyId: 'p1', proxyId: 'px1' }),
      ]),
    );
  });

  it('clearing the ballot proxy picker back to "no proxy" re-enables the cast-by select', async () => {
    mocked.fetchElections.mockResolvedValue([
      election({ id: 'e1', title: 'Board Election 2026', status: 'closed' }),
    ]);
    mocked.fetchProperties.mockResolvedValue([
      property({
        id: 'p1',
        address: '100 Main St',
        owners: [
          {
            id: 'o1',
            propertyId: 'p1',
            fullName: 'Jane Doe',
            phone: null,
            email: null,
            status: 'active',
            notes: null,
          },
        ],
      }),
    ]);
    mocked.fetchProxies.mockResolvedValue([
      {
        id: 'px1',
        propertyId: 'p1',
        address: '100 Main St',
        grantorOwnerId: 'o1',
        grantorName: 'Jane Doe',
        holderName: 'Proxy Holder',
        holderOwnerId: null,
        holderOwnerName: null,
        meetingId: null,
        electionId: 'e1',
      },
    ]);
    render(<ElectionsManager />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^history$/i }),
    );
    await screen.findByText('Board Election 2026');

    await userEvent.click(screen.getByRole('button', { name: /details/i }));
    await userEvent.click(
      screen.getByLabelText(/ballot returned — 100 main st/i),
    );
    const castBySelect = screen.getByLabelText(/cast by — 100 main st/i);
    const proxySelect = screen.getByLabelText(/proxy — 100 main st/i);

    await userEvent.selectOptions(proxySelect, 'px1');
    expect(castBySelect).toBeDisabled();

    await userEvent.selectOptions(proxySelect, '');
    expect(castBySelect).not.toBeDisabled();
    // Clearing the proxy leaves cast-by blank rather than restoring a
    // previous value — there was none to restore, since choosing the proxy
    // is what cleared it in the first place.
    expect(castBySelect).toHaveValue('');
    await userEvent.selectOptions(castBySelect, 'o1');
    expect(castBySelect).toHaveValue('o1');
  });
});
