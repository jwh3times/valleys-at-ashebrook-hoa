import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MeetingsManager from './MeetingsManager';
import * as admin from '../../lib/admin';
import * as content from '../../lib/content';
import { tallyVotes } from '../../lib/types';

vi.mock('../../lib/admin');
vi.mock('../../lib/content');

const mocked = vi.mocked(admin);
const mockedContent = vi.mocked(content);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.fetchBoardPeople.mockResolvedValue([]);
  mocked.fetchProperties.mockResolvedValue([]);
  mocked.fetchMeeting.mockResolvedValue(meetingDetail());
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

const meeting = {
  id: 'm1',
  body: 'board' as const,
  kind: 'special' as const,
  date: '2026-09-14',
  title: 'September meeting',
  status: 'draft' as const,
  visibility: 'board' as const,
  motionCount: 3,
};

const memberMeeting = {
  id: 'm2',
  body: 'member' as const,
  kind: 'annual' as const,
  date: '2026-10-01',
  title: 'Annual member meeting',
  status: 'draft' as const,
  visibility: 'board' as const,
  motionCount: 0,
};

// A full MeetingDetail, matching what GET /api/admin/meetings?id= returns.
function meetingDetail(
  overrides: Partial<Awaited<ReturnType<typeof admin.fetchMeeting>>> = {},
) {
  return {
    ...meeting,
    startTime: null,
    location: null,
    summaryMd: null,
    documentId: null,
    quorumRequired: null,
    attendance: [],
    memberAttendance: [],
    totalActiveWeight: 0,
    motions: [],
    ...overrides,
  };
}

function memberMotion(
  overrides: Partial<
    Awaited<ReturnType<typeof admin.fetchMeeting>>['motions'][number]
  > = {},
) {
  return {
    id: 'mo1',
    sequence: 1,
    text: 'Approve the annual budget',
    votingState: 'none' as const,
    moverName: null,
    secondName: null,
    outcome: 'passed' as const,
    eligibleCount: 0,
    eligibleWeight: 0,
    eligibilityFrozen: false,
    tally: tallyVotes([]),
    votes: [],
    memberVotes: [],
    memberTally: tallyVotes([]),
    ...overrides,
  };
}

describe('MeetingsManager', () => {
  it('shows an empty state when no meetings exist', async () => {
    mocked.fetchMeetings.mockResolvedValue([]);
    render(<MeetingsManager />);
    expect(await screen.findByText(/no meetings.*yet/i)).toBeInTheDocument();
  });

  it('lists a meeting with its date, kind, and motion count', async () => {
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    render(<MeetingsManager />);
    const title = await screen.findByText('September meeting');
    const card = title.closest('.panel-card') as HTMLElement;
    expect(within(card).getByText(/2026-09-14/)).toBeInTheDocument();
    expect(within(card).getByText(/special/i)).toBeInTheDocument();
    expect(within(card).getByText(/3 motions/i)).toBeInTheDocument();
  });

  it('marks a draft meeting as Draft and an approved one as Approved', async () => {
    mocked.fetchMeetings.mockResolvedValue([
      meeting,
      { ...meeting, id: 'm2', title: 'October meeting', status: 'approved' },
    ]);
    render(<MeetingsManager />);
    const draftTitle = await screen.findByText('September meeting');
    const draftCard = draftTitle.closest('.panel-card') as HTMLElement;
    expect(within(draftCard).getByText('Draft')).toBeInTheDocument();

    const approvedTitle = screen.getByText('October meeting');
    const approvedCard = approvedTitle.closest('.panel-card') as HTMLElement;
    expect(within(approvedCard).getByText('Approved')).toBeInTheDocument();
  });

  it('adds a meeting and reloads', async () => {
    mocked.fetchMeetings.mockResolvedValue([]);
    mocked.saveMeeting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText(/no meetings.*yet/i);

    await userEvent.type(
      screen.getByLabelText(/^title$/i),
      'September meeting',
    );
    const dateInput = screen.getByLabelText(/^date$/i);
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2026-09-14');
    await userEvent.click(screen.getByRole('button', { name: /add meeting/i }));

    await waitFor(() =>
      expect(mocked.saveMeeting).toHaveBeenCalledWith(
        {
          body: 'board',
          kind: 'regular',
          date: '2026-09-14',
          title: 'September meeting',
          startTime: null,
          location: null,
          summaryMd: null,
          documentId: null,
          quorumRequired: null,
          visibility: 'board',
        },
        undefined,
      ),
    );
    expect(await screen.findByText(/meeting added/i)).toBeInTheDocument();
  });

  it('editing an existing meeting round-trips a changed summaryMd and quorumRequired', async () => {
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({
        startTime: '7:00 PM',
        location: 'Clubhouse',
        summaryMd: 'Old minutes.',
        documentId: 'doc-1',
        quorumRequired: 3,
      }),
    );
    mocked.saveMeeting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    const summary = await screen.findByLabelText(/^minutes/i);
    expect(summary).toHaveValue('Old minutes.');
    await userEvent.clear(summary);
    await userEvent.type(summary, 'Approved minutes for September.');

    const quorum = screen.getByLabelText(/quorum required/i);
    await userEvent.clear(quorum);
    await userEvent.type(quorum, '5');

    await userEvent.click(
      screen.getByRole('button', { name: /save meeting/i }),
    );

    await waitFor(() =>
      expect(mocked.saveMeeting).toHaveBeenCalledWith(
        {
          kind: 'special',
          date: '2026-09-14',
          title: 'September meeting',
          startTime: '7:00 PM',
          location: 'Clubhouse',
          summaryMd: 'Approved minutes for September.',
          documentId: 'doc-1',
          quorumRequired: 5,
          visibility: 'board',
        },
        'm1',
      ),
    );
    expect(await screen.findByText(/meeting updated/i)).toBeInTheDocument();
  });

  it('omits body when editing an existing meeting', async () => {
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    mocked.saveMeeting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await screen.findByLabelText(/^minutes/i);

    await userEvent.click(
      screen.getByRole('button', { name: /save meeting/i }),
    );

    await waitFor(() => expect(mocked.saveMeeting).toHaveBeenCalled());
    const [payload, id] = mocked.saveMeeting.mock.calls[0];
    expect(id).toBe('m1');
    // Key absence, not `body: undefined` — the server guard fires on
    // presence, so `toBeUndefined()` would pass against a payload that
    // still carries the key.
    expect('body' in payload).toBe(false);
  });

  it('still sends body when creating a meeting', async () => {
    mocked.fetchMeetings.mockResolvedValue([]);
    mocked.saveMeeting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText(/no meetings.*yet/i);

    await userEvent.type(
      screen.getByLabelText(/^title$/i),
      'September meeting',
    );
    const dateInput = screen.getByLabelText(/^date$/i);
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2026-09-14');
    await userEvent.click(screen.getByRole('button', { name: /add meeting/i }));

    await waitFor(() => expect(mocked.saveMeeting).toHaveBeenCalled());
    const [payload, id] = mocked.saveMeeting.mock.calls[0];
    expect(id).toBeUndefined();
    expect('body' in payload).toBe(true);
    expect(payload.body).toBe('board');
  });

  it('emptying summaryMd on an existing meeting persists as cleared, not silently ignored', async () => {
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({ summaryMd: 'Old minutes.' }),
    );
    mocked.saveMeeting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    const summary = await screen.findByLabelText(/^minutes/i);
    expect(summary).toHaveValue('Old minutes.');
    await userEvent.clear(summary);

    await userEvent.click(
      screen.getByRole('button', { name: /save meeting/i }),
    );

    await waitFor(() =>
      expect(mocked.saveMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ summaryMd: null }),
        'm1',
      ),
    );
  });

  it('declining the delete confirmation does not call deleteMeeting', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /delete september meeting/i }),
    );
    expect(confirmSpy).toHaveBeenCalled();
    expect(mocked.deleteMeeting).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('surfaces the 409 text when deleting an approved meeting', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocked.fetchMeetings.mockResolvedValue([
      { ...meeting, status: 'approved' },
    ]);
    mocked.deleteMeeting.mockRejectedValue(
      new Error('Approved meetings cannot be deleted — unapprove first.'),
    );
    render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /delete september meeting/i }),
    );
    expect(await screen.findByText(/unapprove first/i)).toBeInTheDocument();
    expect(screen.queryByText(/409/)).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('shows the derived tally beside the outcome selector', async () => {
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    mocked.fetchBoardPeople.mockResolvedValue([
      { id: 'p1', fullName: 'A. Reyes', userId: null, terms: [] },
      { id: 'p2', fullName: 'B. Ortiz', userId: null, terms: [] },
    ]);
    render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    await screen.findByLabelText('Vote — A. Reyes');
    const tally = () => screen.getByTestId('motion-tally').textContent;
    expect(tally()).toMatch(/0 yes/);

    await userEvent.selectOptions(
      screen.getByLabelText('Vote — A. Reyes'),
      'yes',
    );
    await waitFor(() => expect(tally()).toMatch(/1 yes/));

    await userEvent.selectOptions(
      screen.getByLabelText('Vote — B. Ortiz'),
      'no',
    );
    await waitFor(() => expect(tally()).toMatch(/1 no/));
  });

  it('lists motions loaded from the detail read', async () => {
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    mocked.fetchBoardPeople.mockResolvedValue([
      { id: 'p1', fullName: 'A. Reyes', userId: null, terms: [] },
    ]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({
        motions: [
          {
            id: 'mo1',
            sequence: 1,
            text: 'Move to approve the budget',
            votingState: 'none',
            moverName: 'A. Reyes',
            secondName: null,
            outcome: 'passed',
            eligibleCount: 0,
            eligibleWeight: 0,
            eligibilityFrozen: false,
            tally: {
              yes: 1,
              no: 0,
              abstain: 0,
              recused: 0,
              absent: 0,
              recorded: true,
            },
            votes: [{ personId: 'p1', fullName: 'A. Reyes', choice: 'yes' }],
            memberVotes: [],
            memberTally: tallyVotes([]),
          },
        ],
      }),
    );
    render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );
    expect(
      await screen.findByText('Move to approve the budget'),
    ).toBeInTheDocument();
    expect(mocked.fetchMeeting).toHaveBeenCalledWith('m1');
  });

  it('a motion can be edited', async () => {
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    mocked.fetchBoardPeople.mockResolvedValue([
      { id: 'p1', fullName: 'A. Reyes', userId: null, terms: [] },
    ]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({
        motions: [
          {
            id: 'mo1',
            sequence: 1,
            text: 'Move to approve the budget',
            votingState: 'none',
            moverName: 'A. Reyes',
            secondName: null,
            outcome: 'passed',
            eligibleCount: 0,
            eligibleWeight: 0,
            eligibilityFrozen: false,
            tally: {
              yes: 1,
              no: 0,
              abstain: 0,
              recused: 0,
              absent: 0,
              recorded: true,
            },
            votes: [{ personId: 'p1', fullName: 'A. Reyes', choice: 'yes' }],
            memberVotes: [],
            memberTally: tallyVotes([]),
          },
        ],
      }),
    );
    mocked.saveMotion.mockResolvedValue(undefined);
    mocked.setVotes.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );
    await screen.findByText('Move to approve the budget');

    await userEvent.click(
      screen.getByRole('button', {
        name: /edit motion move to approve the budget/i,
      }),
    );
    expect(screen.getByText('Edit motion')).toBeInTheDocument();
    expect(screen.getByLabelText(/^motion$/i)).toHaveValue(
      'Move to approve the budget',
    );

    await userEvent.click(screen.getByRole('button', { name: /save motion/i }));

    await waitFor(() =>
      expect(mocked.saveMotion).toHaveBeenCalledWith(
        {
          text: 'Move to approve the budget',
          moverPersonId: 'p1',
          secondPersonId: null,
          outcome: 'passed',
        },
        'mo1',
      ),
    );
    expect(mocked.setVotes).toHaveBeenCalledWith('mo1', [
      { personId: 'p1', choice: 'yes' },
    ]);
    expect(await screen.findByText(/motion updated/i)).toBeInTheDocument();
  });

  it('approving a draft meeting calls approveMeeting and reloads', async () => {
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    mocked.approveMeeting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('September meeting');

    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    await waitFor(() =>
      expect(mocked.approveMeeting).toHaveBeenCalledWith('m1'),
    );
    // reload() re-fetches the list — the mount call plus this one.
    await waitFor(() => expect(mocked.fetchMeetings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/meeting approved/i)).toBeInTheDocument();
  });

  it('unapproving an approved meeting calls unapproveMeeting and reloads', async () => {
    mocked.fetchMeetings.mockResolvedValue([
      { ...meeting, status: 'approved' },
    ]);
    mocked.unapproveMeeting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('September meeting');

    await userEvent.click(screen.getByRole('button', { name: /^unapprove$/i }));

    await waitFor(() =>
      expect(mocked.unapproveMeeting).toHaveBeenCalledWith('m1'),
    );
    await waitFor(() => expect(mocked.fetchMeetings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/meeting unapproved/i)).toBeInTheDocument();
  });

  it('submitting attendance sends a row for every roster person, present or not', async () => {
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    mocked.fetchBoardPeople.mockResolvedValue([
      { id: 'p1', fullName: 'A. Reyes', userId: null, terms: [] },
      { id: 'p2', fullName: 'B. Ortiz', userId: null, terms: [] },
    ]);
    mocked.setAttendance.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    // Check A. Reyes present; deliberately leave B. Ortiz unchecked — the
    // save must still send a row for her, present: false, not omit her.
    const reyesCheckbox = await screen.findByLabelText('A. Reyes');
    await userEvent.click(reyesCheckbox);

    await userEvent.click(
      screen.getByRole('button', { name: /save attendance/i }),
    );

    await waitFor(() =>
      expect(mocked.setAttendance).toHaveBeenCalledWith('m1', [
        { personId: 'p1', present: true },
        { personId: 'p2', present: false },
      ]),
    );
    expect(await screen.findByText(/attendance saved/i)).toBeInTheDocument();
  });

  it('shows the property-based editors for a member meeting, not the board ones', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [],
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetail({ ...memberMeeting }));
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    expect(await screen.findByLabelText('12 Oak Lane')).toBeInTheDocument();
    expect(screen.queryByText(/no board roster yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Roll call')).not.toBeInTheDocument();
  });

  it('excludes inactive properties from the member attendance and vote editors', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [],
      },
      {
        id: 'prop2',
        address: '16 Oak Lane',
        unit: null,
        status: 'inactive',
        notes: null,
        voteWeight: 1,
        owners: [],
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetail({ ...memberMeeting }));
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    // Active property is offered in both the attendance and votes editors.
    expect(await screen.findByLabelText('12 Oak Lane')).toBeInTheDocument();
    expect(screen.getByLabelText('Vote — 12 Oak Lane')).toBeInTheDocument();
    // Inactive property is offered in neither — totalActiveWeight (the
    // public quorum denominator) excludes it, so marking it present or
    // casting its vote here would inflate the numerator against a
    // denominator that already leaves it out.
    expect(screen.queryByLabelText('16 Oak Lane')).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Vote — 16 Oak Lane'),
    ).not.toBeInTheDocument();
  });

  it('shows the board editors for a board meeting, not the property ones', async () => {
    mocked.fetchMeetings.mockResolvedValue([meeting]);
    mocked.fetchBoardPeople.mockResolvedValue([
      { id: 'p1', fullName: 'A. Reyes', userId: null, terms: [] },
    ]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [],
      },
    ]);
    render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    expect(await screen.findByLabelText('A. Reyes')).toBeInTheDocument();
    expect(screen.queryByText('12 Oak Lane')).not.toBeInTheDocument();
  });

  it('submitting member attendance sends a row for every property, present or not', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [],
      },
      {
        id: 'prop2',
        address: '14 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 2,
        owners: [],
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetail({ ...memberMeeting }));
    mocked.setMemberAttendance.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    // Check 12 Oak Lane present; deliberately leave 14 Oak Lane unchecked —
    // the save must still send a row for it, present: false, not omit it.
    const oakLaneCheckbox = await screen.findByLabelText('12 Oak Lane');
    await userEvent.click(oakLaneCheckbox);

    await userEvent.click(
      screen.getByRole('button', { name: /save attendance/i }),
    );

    await waitFor(() =>
      expect(mocked.setMemberAttendance).toHaveBeenCalledWith('m2', [
        {
          propertyId: 'prop1',
          present: true,
          representedByOwnerId: null,
          proxyId: null,
        },
        {
          propertyId: 'prop2',
          present: false,
          representedByOwnerId: null,
          proxyId: null,
        },
      ]),
    );
    expect(await screen.findByText(/attendance saved/i)).toBeInTheDocument();
  });

  it('submitting member votes sends only the properties with an entered choice', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [],
      },
      {
        id: 'prop2',
        address: '14 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 3,
        owners: [],
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetail({ ...memberMeeting }));
    mocked.saveMotion.mockResolvedValue('mo1');
    mocked.setMemberVotes.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    await userEvent.type(
      screen.getByLabelText(/^motion$/i),
      'Approve the budget',
    );
    // Cast a vote for 12 Oak Lane; deliberately leave 14 Oak Lane
    // untouched — the save must NOT send a row for it. An untouched lot is
    // absent from the ballot, not a recorded abstention, and a fabricated
    // abstain vote for every silent property is exactly the bug this test
    // pins against.
    await userEvent.selectOptions(
      screen.getByLabelText('Vote — 12 Oak Lane'),
      'yes',
    );

    await userEvent.click(screen.getByRole('button', { name: /add motion/i }));

    await waitFor(() =>
      expect(mocked.setMemberVotes).toHaveBeenCalledWith('mo1', [
        {
          propertyId: 'prop1',
          choice: 'yes',
          castByOwnerId: null,
          proxyId: null,
        },
      ]),
    );
    expect(await screen.findByText(/motion recorded/i)).toBeInTheDocument();
  });

  it('saving a member motion with no votes entered sends no vote rows', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [],
      },
      {
        id: 'prop2',
        address: '14 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 3,
        owners: [],
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetail({ ...memberMeeting }));
    mocked.saveMotion.mockResolvedValue('mo1');
    mocked.setMemberVotes.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    // No votes touched at all — every property's ballot is untouched.
    await userEvent.type(
      screen.getByLabelText(/^motion$/i),
      'Approve the budget',
    );
    await userEvent.click(screen.getByRole('button', { name: /add motion/i }));

    await waitFor(() =>
      expect(mocked.setMemberVotes).toHaveBeenCalledWith('mo1', []),
    );
    expect(await screen.findByText(/motion recorded/i)).toBeInTheDocument();
  });

  it("does not offer the board-roster mover/second pickers on a member meeting's motion form", async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchBoardPeople.mockResolvedValue([
      { id: 'p1', fullName: 'A. Reyes', userId: null, terms: [] },
    ]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [],
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetail({ ...memberMeeting }));
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );
    await screen.findByLabelText(/^motion$/i);

    // The board roster (`people`) is the only mover/second roster this
    // panel has; a member meeting's motion has no correct roster to
    // attribute a mover/second to until owner-attributed movers land, so
    // neither picker should render at all.
    expect(screen.queryByText(/moved by/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/seconded by/i)).not.toBeInTheDocument();
  });

  it('shows the weighted live tally for a member motion, summed per choice across differently-weighted properties', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 5,
        owners: [],
      },
      {
        id: 'prop2',
        address: '14 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 3,
        owners: [],
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetail({ ...memberMeeting }));
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    const tally = () => screen.getByTestId('motion-tally').textContent;
    await screen.findByLabelText('Vote — 12 Oak Lane');
    expect(tally()).toMatch(/0 yes/);

    // Two properties with DIFFERENT weights (5 and 3), both voting yes —
    // an implementation that used only the last-touched row's weight, or
    // ignored all but one row, would also produce a plausible-looking
    // number for a single property; the combined total (8) is what
    // actually proves summation across rows.
    await userEvent.selectOptions(
      screen.getByLabelText('Vote — 12 Oak Lane'),
      'yes',
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Vote — 14 Oak Lane'),
      'yes',
    );
    await waitFor(() => expect(tally()).toMatch(/8 yes/));

    // Flip the weight-3 property to "no" — pins the per-choice bucketing:
    // weight 5 stays under yes, weight 3 moves to no, rather than both
    // landing in one combined bucket.
    await userEvent.selectOptions(
      screen.getByLabelText('Vote — 14 Oak Lane'),
      'no',
    );
    await waitFor(() => expect(tally()).toMatch(/5 yes/));
    expect(tally()).toMatch(/3 no/);
  });

  it('submitting member votes sends the chosen castByOwnerId per property', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [
          {
            id: 'o1',
            propertyId: 'prop1',
            fullName: 'Jane Doe',
            phone: null,
            email: null,
            status: 'active',
            notes: null,
          },
        ],
      },
      {
        id: 'prop2',
        address: '14 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [],
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetail({ ...memberMeeting }));
    mocked.saveMotion.mockResolvedValue('mo1');
    mocked.setMemberVotes.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    await userEvent.type(
      screen.getByLabelText(/^motion$/i),
      'Approve the budget',
    );

    // Scope to 12 Oak Lane's own field container.
    const voteField = screen
      .getByLabelText('Vote — 12 Oak Lane')
      .closest('.field') as HTMLElement;
    await userEvent.selectOptions(
      within(voteField).getByLabelText('Cast by — 12 Oak Lane'),
      'o1',
    );
    // Leave 14 Oak Lane (no owners, so no Cast by control at all)
    // completely untouched — it must NOT be sent at all: touching only Cast
    // by for 12 Oak Lane (never its Vote choice) still records a row for it,
    // defaulting to abstain, because that control itself creates the
    // memberVoteForm entry; a property nothing was ever entered for gets no
    // row and no default. proxyId is not yet settable through this form —
    // see Task 6's picker — so it always sends null here.

    await userEvent.click(screen.getByRole('button', { name: /add motion/i }));

    await waitFor(() =>
      expect(mocked.setMemberVotes).toHaveBeenCalledWith('mo1', [
        {
          propertyId: 'prop1',
          choice: 'abstain',
          castByOwnerId: 'o1',
          proxyId: null,
        },
      ]),
    );
    expect(await screen.findByText(/motion recorded/i)).toBeInTheDocument();
  });

  it('selecting a proxy sends its id and clears representedByOwnerId', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [
          {
            id: 'o1',
            propertyId: 'prop1',
            fullName: 'Jane Doe',
            phone: null,
            email: null,
            status: 'active',
            notes: null,
          },
        ],
      },
    ]);
    mocked.fetchProxies.mockResolvedValue([
      {
        id: 'px1',
        propertyId: 'prop1',
        address: '12 Oak Lane',
        grantorOwnerId: 'o1',
        grantorName: 'Jane Doe',
        holderName: 'Proxy Holder',
        holderOwnerId: null,
        holderOwnerName: null,
        meetingId: 'm2',
        electionId: null,
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({
        ...memberMeeting,
        memberAttendance: [
          {
            propertyId: 'prop1',
            address: '12 Oak Lane',
            present: true,
            weight: 1,
            representedByName: 'Jane Doe',
            viaProxy: false,
            proxyId: null,
          },
        ],
      }),
    );
    mocked.setMemberAttendance.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    // Pre-selected represented-by owner from the loaded detail row.
    const repSelect = await screen.findByLabelText(
      /represented by — 12 oak lane/i,
    );
    expect(repSelect).toHaveValue('o1');

    // Scope to the attendance form specifically — the votes editor below it
    // renders its own, identically-labelled proxy picker for the same lot.
    const attendanceForm = screen
      .getByRole('button', { name: /save attendance/i })
      .closest('form') as HTMLElement;
    await userEvent.selectOptions(
      within(attendanceForm).getByLabelText(/proxy — 12 oak lane/i),
      'px1',
    );

    // Choosing the proxy clears AND disables the represented-by select.
    expect(repSelect).toHaveValue('');
    expect(repSelect).toBeDisabled();

    await userEvent.click(
      screen.getByRole('button', { name: /save attendance/i }),
    );

    await waitFor(() =>
      expect(mocked.setMemberAttendance).toHaveBeenCalledWith('m2', [
        {
          propertyId: 'prop1',
          present: true,
          representedByOwnerId: null,
          proxyId: 'px1',
        },
      ]),
    );
  });

  it('selecting a proxy for a member vote sends its id and clears castByOwnerId', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 1,
        owners: [
          {
            id: 'o1',
            propertyId: 'prop1',
            fullName: 'Jane Doe',
            phone: null,
            email: null,
            status: 'active',
            notes: null,
          },
        ],
      },
    ]);
    mocked.fetchProxies.mockResolvedValue([
      {
        id: 'px1',
        propertyId: 'prop1',
        address: '12 Oak Lane',
        grantorOwnerId: 'o1',
        grantorName: 'Jane Doe',
        holderName: 'Proxy Holder',
        holderOwnerId: null,
        holderOwnerName: null,
        meetingId: 'm2',
        electionId: null,
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetail({ ...memberMeeting }));
    mocked.saveMotion.mockResolvedValue('mo1');
    mocked.setMemberVotes.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    await userEvent.type(
      screen.getByLabelText(/^motion$/i),
      'Approve the budget',
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Vote — 12 Oak Lane'),
      'yes',
    );
    const castBySelect = screen.getByLabelText(/cast by — 12 oak lane/i);
    await userEvent.selectOptions(castBySelect, 'o1');
    expect(castBySelect).toHaveValue('o1');

    // Scope to the motion form specifically — the attendance editor above
    // it renders its own, identically-labelled proxy picker for the same lot.
    const motionForm = screen
      .getByRole('button', { name: /add motion/i })
      .closest('form') as HTMLElement;
    await userEvent.selectOptions(
      within(motionForm).getByLabelText(/proxy — 12 oak lane/i),
      'px1',
    );

    expect(castBySelect).toHaveValue('');
    expect(castBySelect).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /add motion/i }));

    await waitFor(() =>
      expect(mocked.setMemberVotes).toHaveBeenCalledWith('mo1', [
        {
          propertyId: 'prop1',
          choice: 'yes',
          castByOwnerId: null,
          proxyId: 'px1',
        },
      ]),
    );
  });

  it('offers Open voting for a member motion with no live-voting history', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting
      .mockResolvedValueOnce(
        meetingDetail({ ...memberMeeting, motions: [memberMotion()] }),
      )
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion({ votingState: 'open' })],
        }),
      );
    mocked.openMotionVoting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    await userEvent.click(
      await screen.findByRole('button', {
        name: /open voting for approve the annual budget/i,
      }),
    );

    await waitFor(() =>
      expect(mocked.openMotionVoting).toHaveBeenCalledWith('mo1'),
    );
    expect(
      await screen.findByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /open voting for approve the annual budget/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('preserves edits to another motion when opening voting', async () => {
    const otherMotion = memberMotion({
      id: 'mo2',
      sequence: 2,
      text: 'Repair the pool fence',
    });
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion(), otherMotion],
        }),
      )
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion({ votingState: 'open' }), otherMotion],
        }),
      );
    mocked.openMotionVoting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: /edit motion repair the pool fence/i,
      }),
    );
    const motionInput = screen.getByLabelText(/^motion$/i);
    await userEvent.clear(motionInput);
    await userEvent.type(motionInput, 'Repair the pool fence this fall');

    await userEvent.click(
      screen.getByRole('button', {
        name: /open voting for approve the annual budget/i,
      }),
    );

    expect(
      await screen.findByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Edit motion')).toBeInTheDocument();
    expect(screen.getByLabelText(/^motion$/i)).toHaveValue(
      'Repair the pool fence this fall',
    );
  });

  it('preserves an add-motion draft when opening voting', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting
      .mockResolvedValueOnce(
        meetingDetail({ ...memberMeeting, motions: [memberMotion()] }),
      )
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion({ votingState: 'open' })],
        }),
      );
    mocked.openMotionVoting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );
    await userEvent.type(
      screen.getByLabelText(/^motion$/i),
      'Add more shade trees',
    );

    await userEvent.click(
      screen.getByRole('button', {
        name: /open voting for approve the annual budget/i,
      }),
    );

    expect(
      await screen.findByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Edit motion')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^motion$/i)).toHaveValue(
      'Add more shade trees',
    );
  });

  it('preserves edits to another motion when closing voting', async () => {
    const otherMotion = memberMotion({
      id: 'mo2',
      sequence: 2,
      text: 'Repair the pool fence',
    });
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion({ votingState: 'open' }), otherMotion],
        }),
      )
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion({ votingState: 'closed' }), otherMotion],
        }),
      );
    mocked.closeMotionVoting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: /edit motion repair the pool fence/i,
      }),
    );
    const motionInput = screen.getByLabelText(/^motion$/i);
    await userEvent.clear(motionInput);
    await userEvent.type(motionInput, 'Repair the pool fence this fall');

    await userEvent.click(
      screen.getByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    );

    expect(
      await screen.findByRole('button', {
        name: /reopen voting for approve the annual budget/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Edit motion')).toBeInTheDocument();
    expect(screen.getByLabelText(/^motion$/i)).toHaveValue(
      'Repair the pool fence this fall',
    );
  });

  it('locks motion controls while opening voting and resets the same-target editor on success', async () => {
    const otherMotion = memberMotion({
      id: 'mo2',
      sequence: 2,
      text: 'Repair the pool fence',
    });
    const pending = deferred<void>();
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion(), otherMotion],
        }),
      )
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion({ votingState: 'open' }), otherMotion],
        }),
      );
    mocked.openMotionVoting.mockReturnValue(pending.promise);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: /edit motion approve the annual budget/i,
      }),
    );
    await userEvent.clear(screen.getByLabelText(/^motion$/i));
    await userEvent.type(
      screen.getByLabelText(/^motion$/i),
      'Approve the amended annual budget',
    );

    await userEvent.click(
      screen.getByRole('button', {
        name: /open voting for approve the annual budget/i,
      }),
    );
    await waitFor(() =>
      expect(mocked.openMotionVoting).toHaveBeenCalledWith('mo1'),
    );
    const editOtherDisabled = screen
      .getByRole('button', { name: /edit motion repair the pool fence/i })
      .hasAttribute('disabled');
    const otherLifecycleDisabled = screen
      .getByRole('button', { name: /open voting for repair the pool fence/i })
      .hasAttribute('disabled');

    pending.resolve(undefined);
    expect(
      await screen.findByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    ).toBeInTheDocument();
    expect(editOtherDisabled).toBe(true);
    expect(otherLifecycleDisabled).toBe(true);
    expect(screen.queryByText('Edit motion')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^motion$/i)).toHaveValue('');
  });

  it('restores motion controls and preserves the editor when opening voting is rejected', async () => {
    const otherMotion = memberMotion({
      id: 'mo2',
      sequence: 2,
      text: 'Repair the pool fence',
    });
    const pending = deferred<void>();
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({
        ...memberMeeting,
        motions: [memberMotion(), otherMotion],
      }),
    );
    mocked.openMotionVoting.mockReturnValue(pending.promise);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: /edit motion approve the annual budget/i,
      }),
    );
    await userEvent.clear(screen.getByLabelText(/^motion$/i));
    await userEvent.type(
      screen.getByLabelText(/^motion$/i),
      'Approve the amended annual budget',
    );

    await userEvent.click(
      screen.getByRole('button', {
        name: /open voting for approve the annual budget/i,
      }),
    );
    await waitFor(() =>
      expect(mocked.openMotionVoting).toHaveBeenCalledWith('mo1'),
    );
    const editOtherButton = screen.getByRole('button', {
      name: /edit motion repair the pool fence/i,
    });
    const otherLifecycleButton = screen.getByRole('button', {
      name: /open voting for repair the pool fence/i,
    });
    const editOtherDisabled = editOtherButton.hasAttribute('disabled');
    const otherLifecycleDisabled =
      otherLifecycleButton.hasAttribute('disabled');

    pending.reject(new Error('Voting cannot open while another update runs.'));
    expect(
      await screen.findByText(/voting cannot open while another update runs/i),
    ).toBeInTheDocument();
    expect(editOtherDisabled).toBe(true);
    expect(otherLifecycleDisabled).toBe(true);
    expect(editOtherButton).toBeEnabled();
    expect(otherLifecycleButton).toBeEnabled();
    expect(screen.getByText('Edit motion')).toBeInTheDocument();
    expect(screen.getByLabelText(/^motion$/i)).toHaveValue(
      'Approve the amended annual budget',
    );
    expect(mocked.fetchMeeting).toHaveBeenCalledTimes(1);
  });

  it('offers Close voting for an open member motion', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion({ votingState: 'open' })],
        }),
      )
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion({ votingState: 'closed' })],
        }),
      );
    mocked.closeMotionVoting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    await userEvent.click(
      await screen.findByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    );

    await waitFor(() =>
      expect(mocked.closeMotionVoting).toHaveBeenCalledWith('mo1'),
    );
    expect(
      await screen.findByRole('button', {
        name: /reopen voting for approve the annual budget/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('offers Reopen voting for a closed member motion', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion({ votingState: 'closed' })],
        }),
      )
      .mockResolvedValueOnce(
        meetingDetail({
          ...memberMeeting,
          motions: [memberMotion({ votingState: 'open' })],
        }),
      );
    mocked.openMotionVoting.mockResolvedValue(undefined);
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    await userEvent.click(
      await screen.findByRole('button', {
        name: /reopen voting for approve the annual budget/i,
      }),
    );

    await waitFor(() =>
      expect(mocked.openMotionVoting).toHaveBeenCalledWith('mo1'),
    );
    expect(
      await screen.findByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /reopen voting for approve the annual budget/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('marks an open member motion paused globally', async () => {
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
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({
        ...memberMeeting,
        motions: [memberMotion({ votingState: 'open' })],
      }),
    );
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    const motionTitle = await screen.findByText('Approve the annual budget');
    const motionRow = motionTitle.closest('.list-row') as HTMLElement;
    expect(within(motionRow).getByText('Paused globally')).toBeInTheDocument();
  });

  it('marks an open member motion paused when official mode is off', async () => {
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
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({
        ...memberMeeting,
        motions: [memberMotion({ votingState: 'open' })],
      }),
    );
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    const motionTitle = await screen.findByText('Approve the annual budget');
    const motionRow = motionTitle.closest('.list-row') as HTMLElement;
    expect(within(motionRow).getByText('Paused globally')).toBeInTheDocument();
  });

  it('surfaces a readable motion lifecycle error without falsely opening', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({ ...memberMeeting, motions: [memberMotion()] }),
    );
    mocked.openMotionVoting.mockRejectedValue(
      new Error('Official mode and live voting must both be enabled.'),
    );
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    await userEvent.click(
      await screen.findByRole('button', {
        name: /open voting for approve the annual budget/i,
      }),
    );

    expect(
      await screen.findByText(/official mode and live voting/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /open voting for approve the annual budget/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    ).not.toBeInTheDocument();
    expect(mocked.fetchMeeting).toHaveBeenCalledTimes(1);
  });

  it('clears a pre-open vote draft and reseeds from authoritative votes after close', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 2,
        owners: [],
      },
    ]);
    const authoritativeVote = {
      propertyId: 'prop1',
      address: '12 Oak Lane',
      choice: 'yes' as const,
      weight: 2,
      castByName: null,
      viaProxy: false,
      proxyId: null,
    };
    mocked.openMotionVoting.mockResolvedValue(undefined);
    mocked.closeMotionVoting.mockResolvedValue(undefined);
    mocked.saveMotion.mockResolvedValue(undefined);
    mocked.setMemberVotes.mockResolvedValue(undefined);
    mocked.fetchMeeting.mockImplementation(async () => {
      const votingState =
        mocked.closeMotionVoting.mock.calls.length > 0
          ? 'closed'
          : mocked.openMotionVoting.mock.calls.length > 0
            ? 'open'
            : 'none';
      return meetingDetail({
        ...memberMeeting,
        motions: [
          memberMotion({
            votingState,
            eligibleCount: votingState === 'none' ? 0 : 1,
            eligibleWeight: votingState === 'none' ? 0 : 2,
            eligibilityFrozen: votingState !== 'none',
            memberVotes: votingState === 'none' ? [] : [authoritativeVote],
            memberTally:
              votingState === 'none'
                ? tallyVotes([])
                : tallyVotes([authoritativeVote]),
          }),
        ],
      });
    });
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: /edit motion approve the annual budget/i,
      }),
    );

    const vote = screen.getByLabelText('Vote — 12 Oak Lane');
    await userEvent.selectOptions(vote, 'no');
    expect(vote).toHaveValue('no');

    await userEvent.click(
      screen.getByRole('button', {
        name: /open voting for approve the annual budget/i,
      }),
    );
    expect(
      await screen.findByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', {
        name: /close voting for approve the annual budget/i,
      }),
    );
    expect(
      await screen.findByRole('button', {
        name: /reopen voting for approve the annual budget/i,
      }),
    ).toBeInTheDocument();

    // Lifecycle success must leave the add form clean. If the old edit state
    // survives, the pre-open "no" value reappears here and can overwrite the
    // live-session vote through setMemberVotes.
    expect(screen.getByLabelText('Vote — 12 Oak Lane')).toHaveValue('');

    await userEvent.click(
      screen.getByRole('button', {
        name: /edit motion approve the annual budget/i,
      }),
    );
    expect(screen.getByLabelText('Vote — 12 Oak Lane')).toHaveValue('yes');

    await userEvent.click(screen.getByRole('button', { name: /save motion/i }));
    await waitFor(() =>
      expect(mocked.setMemberVotes).toHaveBeenLastCalledWith('mo1', [
        {
          propertyId: 'prop1',
          choice: 'yes',
          castByOwnerId: null,
          proxyId: null,
        },
      ]),
    );
  });

  it('hides only the bulk member-vote editor while editing an open motion', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchProperties.mockResolvedValue([
      {
        id: 'prop1',
        address: '12 Oak Lane',
        unit: null,
        status: 'active',
        notes: null,
        voteWeight: 2,
        owners: [],
      },
    ]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({
        ...memberMeeting,
        motions: [memberMotion({ votingState: 'open' })],
      }),
    );
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: /edit motion approve the annual budget/i,
      }),
    );

    expect(screen.getByLabelText(/^motion$/i)).toHaveValue(
      'Approve the annual budget',
    );
    expect(
      screen.queryByLabelText('Vote — 12 Oak Lane'),
    ).not.toBeInTheDocument();
  });

  it('shows the historical weighted tally with its frozen eligible weight after close', async () => {
    mocked.fetchMeetings.mockResolvedValue([memberMeeting]);
    mocked.fetchMeeting.mockResolvedValue(
      meetingDetail({
        ...memberMeeting,
        motions: [
          memberMotion({
            votingState: 'closed',
            eligibleCount: 4,
            eligibleWeight: 10,
            eligibilityFrozen: true,
            memberTally: {
              yes: 6,
              no: 2,
              abstain: 1,
              recused: 0,
              absent: 0,
              recorded: true,
            },
          }),
        ],
      }),
    );
    render(<MeetingsManager />);
    await screen.findByText('Annual member meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    const motionTitle = await screen.findByText('Approve the annual budget');
    const motionRow = motionTitle.closest('.list-row') as HTMLElement;
    expect(within(motionRow).getByText(/weighted 6 yes/i)).toBeInTheDocument();
    expect(
      within(motionRow).getByText(/10 eligible weight \(frozen\)/i),
    ).toBeInTheDocument();
  });
});
