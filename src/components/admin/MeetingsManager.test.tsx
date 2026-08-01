import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MeetingsManager from './MeetingsManager';
import * as admin from '../../lib/admin';

vi.mock('../../lib/admin');

const mocked = vi.mocked(admin);

beforeEach(() => {
  vi.resetAllMocks();
  mocked.fetchBoardPeople.mockResolvedValue([]);
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
    const { container } = render(<MeetingsManager />);
    await screen.findByText('September meeting');
    await userEvent.click(
      screen.getByRole('button', { name: /attendance & motions/i }),
    );

    await screen.findByLabelText('Vote — A. Reyes');
    const tally = () => container.querySelector('.motion-tally')?.textContent;
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
});
