import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ResolutionsManager from './ResolutionsManager';
import * as admin from '../../lib/admin';
import { RESOLUTION_STATUSES } from '../../lib/types';
import type { ResolutionDetail } from '../../lib/types';

vi.mock('../../lib/admin');

const mocked = vi.mocked(admin);

beforeEach(() => {
  vi.resetAllMocks();
  // The motion picker fetches meetings (and, for any with motions, their
  // detail) on every mount — default to none so tests that don't care about
  // the picker aren't forced to mock it.
  mocked.fetchMeetings.mockResolvedValue([]);
});

function resolution(
  overrides: Partial<ResolutionDetail> = {},
): ResolutionDetail {
  return {
    id: 'r1',
    number: '2024-01',
    title: 'Pool Hours',
    status: 'draft',
    visibility: 'board',
    effectiveDate: null,
    bodyMd: 'Pool hours are 9am-9pm.',
    adoptedByMotionId: null,
    supersedesId: null,
    supersededByNumber: null,
    chain: [],
    ...overrides,
  };
}

// A meeting with one motion, used by the motion-picker tests below.
const meetingWithMotion = {
  id: 'm1',
  body: 'board' as const,
  kind: 'regular' as const,
  date: '2026-09-14',
  title: 'September meeting',
  status: 'approved' as const,
  visibility: 'board' as const,
  motionCount: 1,
};

function meetingDetailWithMotion(
  overrides: Partial<Awaited<ReturnType<typeof admin.fetchMeeting>>> = {},
) {
  return {
    ...meetingWithMotion,
    startTime: null,
    location: null,
    summaryMd: null,
    documentId: null,
    quorumRequired: null,
    attendance: [],
    memberAttendance: [],
    totalActiveWeight: 0,
    motions: [
      {
        id: 'mo1',
        sequence: 1,
        text: 'Approve the budget',
        votingState: 'none' as const,
        moverName: null,
        secondName: null,
        outcome: 'passed' as const,
        eligibleCount: 0,
        eligibleWeight: 0,
        eligibilityFrozen: false,
        tally: {
          yes: 0,
          no: 0,
          abstain: 0,
          recused: 0,
          absent: 0,
          recorded: false,
        },
        votes: [],
        memberVotes: [],
        memberTally: {
          yes: 0,
          no: 0,
          abstain: 0,
          recused: 0,
          absent: 0,
          recorded: false,
        },
      },
    ],
    ...overrides,
  };
}

describe('ResolutionsManager', () => {
  it('shows an empty state when no resolutions exist', async () => {
    mocked.fetchResolutions.mockResolvedValue([]);
    render(<ResolutionsManager />);
    expect(await screen.findByText(/no resolutions yet/i)).toBeInTheDocument();
  });

  it('groups resolutions by status with in-force first', async () => {
    mocked.fetchResolutions.mockResolvedValue([
      resolution({ id: 'r-draft', number: '2024-04', status: 'draft' }),
      resolution({ id: 'r-repealed', number: '2024-03', status: 'repealed' }),
      resolution({
        id: 'r-superseded',
        number: '2024-02',
        status: 'superseded',
        supersededByNumber: '2024-05',
      }),
      resolution({
        id: 'r-inforce',
        number: '2024-05',
        status: 'in_force',
        effectiveDate: '2024-05-01',
      }),
    ]);
    render(<ResolutionsManager />);
    await screen.findByText('2024-05 — Pool Hours');

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['In force', 'Superseded', 'Repealed', 'Drafts']);

    // Pin real DOM order, not just heading presence: each resolution's
    // number must land after its own group heading and before the next one.
    const text = document.querySelector('.panel-list')?.textContent ?? '';
    const idx = (s: string) => text.indexOf(s);
    expect(idx('In force')).toBeGreaterThanOrEqual(0);
    expect(idx('In force')).toBeLessThan(idx('2024-05'));
    expect(idx('2024-05')).toBeLessThan(idx('Superseded'));
    expect(idx('Superseded')).toBeLessThan(idx('2024-02'));
    expect(idx('2024-02')).toBeLessThan(idx('Repealed'));
    expect(idx('Repealed')).toBeLessThan(idx('2024-03'));
    expect(idx('2024-03')).toBeLessThan(idx('Drafts'));
    expect(idx('Drafts')).toBeLessThan(idx('2024-04'));
  });

  it('adds a draft and reloads', async () => {
    mocked.fetchResolutions.mockResolvedValue([]);
    mocked.saveResolution.mockResolvedValue(undefined);
    render(<ResolutionsManager />);
    await screen.findByText(/no resolutions yet/i);

    await userEvent.type(screen.getByLabelText(/^number$/i), '2024-01');
    await userEvent.type(screen.getByLabelText(/^title$/i), 'Pool Hours');
    await userEvent.type(
      screen.getByLabelText(/^text$/i),
      'Pool hours are 9am-9pm.',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /add resolution/i }),
    );

    await waitFor(() =>
      expect(mocked.saveResolution).toHaveBeenCalledWith(
        {
          number: '2024-01',
          title: 'Pool Hours',
          bodyMd: 'Pool hours are 9am-9pm.',
          effectiveDate: null,
          visibility: 'board',
        },
        undefined,
      ),
    );
    expect(await screen.findByText(/resolution added/i)).toBeInTheDocument();
  });

  it('adopting a draft calls adoptResolution with the effective date', async () => {
    mocked.fetchResolutions.mockResolvedValue([
      resolution({ id: 'r1', number: '2024-01', status: 'draft' }),
    ]);
    mocked.adoptResolution.mockResolvedValue(undefined);
    render(<ResolutionsManager />);
    await screen.findByText(/2024-01/);

    await userEvent.click(screen.getByRole('button', { name: /^adopt$/i }));
    const effectiveDate = await screen.findByLabelText(/^effective date$/i);
    await userEvent.type(effectiveDate, '2026-09-01');
    await userEvent.click(
      screen.getByRole('button', { name: /confirm adopt/i }),
    );

    await waitFor(() =>
      expect(mocked.adoptResolution).toHaveBeenCalledWith(
        'r1',
        '2026-09-01',
        undefined,
      ),
    );
    expect(await screen.findByText(/resolution adopted/i)).toBeInTheDocument();
  });

  it('superseding calls supersedeResolution with the predecessor id', async () => {
    mocked.fetchResolutions.mockResolvedValue([
      resolution({ id: 'r-draft', number: '2024-02', status: 'draft' }),
      resolution({
        id: 'r-old',
        number: '2024-01',
        title: 'Old Pool Hours',
        status: 'in_force',
        effectiveDate: '2023-01-01',
      }),
    ]);
    mocked.supersedeResolution.mockResolvedValue(undefined);
    render(<ResolutionsManager />);
    await screen.findByText(/2024-02/);

    await userEvent.click(
      screen.getByRole('button', { name: /^supersede…$/i }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/^supersedes$/i),
      'r-old',
    );
    await userEvent.type(
      screen.getByLabelText(/^effective date$/i),
      '2026-09-01',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /confirm supersede/i }),
    );

    await waitFor(() =>
      expect(mocked.supersedeResolution).toHaveBeenCalledWith(
        'r-draft',
        'r-old',
        '2026-09-01',
        undefined,
      ),
    );
    expect(await screen.findByText(/now in force/i)).toBeInTheDocument();
  });

  it('repealing asks for confirmation and calls repealResolution', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocked.fetchResolutions.mockResolvedValue([
      resolution({
        id: 'r1',
        number: '2024-01',
        status: 'in_force',
        effectiveDate: '2024-01-01',
      }),
    ]);
    mocked.repealResolution.mockResolvedValue(undefined);
    render(<ResolutionsManager />);
    await screen.findByText('2024-01 — Pool Hours');

    await userEvent.click(
      screen.getByRole('button', { name: /repeal 2024-01/i }),
    );

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(mocked.repealResolution).toHaveBeenCalledWith('r1'),
    );
    expect(await screen.findByText(/resolution repealed/i)).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('declining the delete confirmation does not call deleteResolution', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mocked.fetchResolutions.mockResolvedValue([
      resolution({ id: 'r1', number: '2024-01', status: 'draft' }),
    ]);
    render(<ResolutionsManager />);
    await screen.findByText(/2024-01/);

    await userEvent.click(
      screen.getByRole('button', { name: /delete 2024-01/i }),
    );

    expect(confirmSpy).toHaveBeenCalled();
    expect(mocked.deleteResolution).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('surfaces the 409 text when adopting an already-in-force resolution', async () => {
    mocked.fetchResolutions.mockResolvedValue([
      resolution({ id: 'r1', number: '2024-01', status: 'draft' }),
    ]);
    mocked.adoptResolution.mockRejectedValue(
      new Error('Resolution is not a draft'),
    );
    render(<ResolutionsManager />);
    await screen.findByText(/2024-01/);

    await userEvent.click(screen.getByRole('button', { name: /^adopt$/i }));
    await userEvent.type(
      await screen.findByLabelText(/^effective date$/i),
      '2026-09-01',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /confirm adopt/i }),
    );

    expect(await screen.findByText(/not a draft/i)).toBeInTheDocument();
    expect(screen.queryByText(/409/)).not.toBeInTheDocument();
  });

  it('the form offers no status control', async () => {
    mocked.fetchResolutions.mockResolvedValue([]);
    render(<ResolutionsManager />);
    await screen.findByText(/no resolutions yet/i);

    const form = screen
      .getByRole('button', { name: /^add resolution$/i })
      .closest('form') as HTMLElement;
    expect(within(form).queryByLabelText(/status/i)).not.toBeInTheDocument();
    expect(within(form).queryByText(/^status$/i)).not.toBeInTheDocument();

    // Guard against a status control smuggled in without a matching label:
    // no combobox in the form may offer any resolution status as an option.
    for (const select of within(form).queryAllByRole('combobox')) {
      const optionText = within(select as HTMLElement)
        .getAllByRole('option')
        .map((o) => o.textContent)
        .join(' ')
        .toLowerCase();
      for (const status of RESOLUTION_STATUSES) {
        expect(optionText).not.toContain(status.replace('_', ' '));
      }
    }
  });

  it('the motion picker lists motions from fetched meetings, and adopting with one selected calls adoptResolution with its id', async () => {
    mocked.fetchResolutions.mockResolvedValue([
      resolution({ id: 'r1', number: '2024-01', status: 'draft' }),
    ]);
    mocked.fetchMeetings.mockResolvedValue([meetingWithMotion]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetailWithMotion());
    mocked.adoptResolution.mockResolvedValue(undefined);
    render(<ResolutionsManager />);
    await screen.findByText('2024-01 — Pool Hours');

    await userEvent.click(screen.getByRole('button', { name: /^adopt$/i }));
    const motionSelect = await screen.findByLabelText(/^motion \(optional\)$/i);
    await screen.findByRole('option', {
      name: '2026-09-14 — Approve the budget',
    });
    await userEvent.selectOptions(motionSelect, 'mo1');
    await userEvent.type(
      screen.getByLabelText(/^effective date$/i),
      '2026-09-01',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /confirm adopt/i }),
    );

    await waitFor(() =>
      expect(mocked.adoptResolution).toHaveBeenCalledWith(
        'r1',
        '2026-09-01',
        'mo1',
      ),
    );
  });

  it('adopting with no motion selected calls adoptResolution with undefined, not empty string', async () => {
    mocked.fetchResolutions.mockResolvedValue([
      resolution({ id: 'r1', number: '2024-01', status: 'draft' }),
    ]);
    mocked.fetchMeetings.mockResolvedValue([meetingWithMotion]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetailWithMotion());
    mocked.adoptResolution.mockResolvedValue(undefined);
    render(<ResolutionsManager />);
    await screen.findByText('2024-01 — Pool Hours');

    await userEvent.click(screen.getByRole('button', { name: /^adopt$/i }));
    // Wait for the picker to finish loading so its default ("— no motion —")
    // is the settled value, not a race against the fetch.
    await screen.findByRole('option', {
      name: '2026-09-14 — Approve the budget',
    });
    await userEvent.type(
      screen.getByLabelText(/^effective date$/i),
      '2026-09-01',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /confirm adopt/i }),
    );

    await waitFor(() =>
      expect(mocked.adoptResolution).toHaveBeenCalledWith(
        'r1',
        '2026-09-01',
        undefined,
      ),
    );
    const [, , motionArg] = mocked.adoptResolution.mock.calls[0];
    expect(motionArg).not.toBe('');
  });

  it('the motion picker is offered for supersede too, and superseding with one selected calls supersedeResolution with its id', async () => {
    mocked.fetchResolutions.mockResolvedValue([
      resolution({ id: 'r-draft', number: '2024-02', status: 'draft' }),
      resolution({
        id: 'r-old',
        number: '2024-01',
        title: 'Old Pool Hours',
        status: 'in_force',
        effectiveDate: '2023-01-01',
      }),
    ]);
    mocked.fetchMeetings.mockResolvedValue([meetingWithMotion]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetailWithMotion());
    mocked.supersedeResolution.mockResolvedValue(undefined);
    render(<ResolutionsManager />);
    await screen.findByText('2024-02 — Pool Hours');

    await userEvent.click(
      screen.getByRole('button', { name: /^supersede…$/i }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/^supersedes$/i),
      'r-old',
    );
    const motionSelect = await screen.findByLabelText(/^motion \(optional\)$/i);
    await screen.findByRole('option', {
      name: '2026-09-14 — Approve the budget',
    });
    await userEvent.selectOptions(motionSelect, 'mo1');
    await userEvent.type(
      screen.getByLabelText(/^effective date$/i),
      '2026-09-01',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /confirm supersede/i }),
    );

    await waitFor(() =>
      expect(mocked.supersedeResolution).toHaveBeenCalledWith(
        'r-draft',
        'r-old',
        '2026-09-01',
        'mo1',
      ),
    );
  });

  it('superseding with no motion selected calls supersedeResolution with undefined, not empty string', async () => {
    mocked.fetchResolutions.mockResolvedValue([
      resolution({ id: 'r-draft', number: '2024-02', status: 'draft' }),
      resolution({
        id: 'r-old',
        number: '2024-01',
        title: 'Old Pool Hours',
        status: 'in_force',
        effectiveDate: '2023-01-01',
      }),
    ]);
    mocked.fetchMeetings.mockResolvedValue([meetingWithMotion]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetailWithMotion());
    mocked.supersedeResolution.mockResolvedValue(undefined);
    render(<ResolutionsManager />);
    await screen.findByText('2024-02 — Pool Hours');

    await userEvent.click(
      screen.getByRole('button', { name: /^supersede…$/i }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/^supersedes$/i),
      'r-old',
    );
    await screen.findByRole('option', {
      name: '2026-09-14 — Approve the budget',
    });
    await userEvent.type(
      screen.getByLabelText(/^effective date$/i),
      '2026-09-01',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /confirm supersede/i }),
    );

    await waitFor(() =>
      expect(mocked.supersedeResolution).toHaveBeenCalledWith(
        'r-draft',
        'r-old',
        '2026-09-01',
        undefined,
      ),
    );
    const [, , , motionArg] = mocked.supersedeResolution.mock.calls[0];
    expect(motionArg).not.toBe('');
  });

  it('a resolution with adoptedByMotionId set renders its motion reference, not a bare UUID', async () => {
    mocked.fetchResolutions.mockResolvedValue([
      resolution({
        id: 'r1',
        number: '2024-01',
        status: 'in_force',
        effectiveDate: '2024-01-01',
        adoptedByMotionId: 'mo1',
      }),
    ]);
    mocked.fetchMeetings.mockResolvedValue([meetingWithMotion]);
    mocked.fetchMeeting.mockResolvedValue(meetingDetailWithMotion());
    render(<ResolutionsManager />);

    expect(
      await screen.findByText(/2026-09-14 — Approve the budget/),
    ).toBeInTheDocument();
    expect(screen.queryByText('mo1')).not.toBeInTheDocument();
  });

  it('editing an existing resolution calls saveResolution with its id', async () => {
    mocked.fetchResolutions.mockResolvedValue([
      resolution({ id: 'r1', number: '2024-01', status: 'draft' }),
    ]);
    mocked.saveResolution.mockResolvedValue(undefined);
    render(<ResolutionsManager />);
    await screen.findByText('2024-01 — Pool Hours');

    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const titleInput = screen.getByLabelText(/^title$/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Updated Pool Hours');
    await userEvent.click(
      screen.getByRole('button', { name: /save resolution/i }),
    );

    await waitFor(() =>
      expect(mocked.saveResolution).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Updated Pool Hours' }),
        'r1',
      ),
    );
  });
});
