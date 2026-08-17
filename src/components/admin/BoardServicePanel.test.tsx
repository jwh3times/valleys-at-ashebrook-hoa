import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BoardServicePanel from './BoardServicePanel';
import * as rosterAdmin from '../../lib/roster-admin';
import * as admin from '../../lib/admin';
import type {
  BoardServiceDetail,
  BoardServiceTermRow,
  BoardOfficeRow,
} from '../../lib/roster-admin';

vi.mock('../../lib/roster-admin');
vi.mock('../../lib/admin');

const mockedRoster = vi.mocked(rosterAdmin);
const mockedAdmin = vi.mocked(admin);

function term(
  overrides: Partial<BoardServiceTermRow> = {},
): BoardServiceTermRow {
  return {
    id: 't1',
    personId: 'p1',
    personName: 'Dana Reeves',
    qualifyingLotId: 'l1',
    qualifyingLotAddress: '12 Valley Way',
    electionId: null,
    startDay: '2026-01-01',
    scheduledEndDay: '2027-01-01',
    actualEndDay: null,
    cancelledDay: null,
    voided: false,
    current: true,
    ...overrides,
  };
}

function office(overrides: Partial<BoardOfficeRow> = {}): BoardOfficeRow {
  return {
    id: 'o1',
    boardTermId: 't1',
    personId: 'p1',
    personName: 'Dana Reeves',
    office: 'president',
    startDay: '2026-01-01',
    endDay: null,
    voided: false,
    current: true,
    ...overrides,
  };
}

function service(
  overrides: Partial<BoardServiceDetail> = {},
): BoardServiceDetail {
  return {
    terms: [],
    offices: [],
    advisories: {
      currentMemberCount: 0,
      belowMinimum: false,
      aboveMaximum: false,
      vacantOffices: [],
      expiringTermIds: [],
      lapsedTermIds: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // The pickers load on every mount; default them to something so tests that
  // don't exercise a picker aren't forced to mock all three.
  mockedAdmin.fetchRosterPeople.mockResolvedValue([
    { partyId: 'p1', displayName: 'Dana Reeves' },
  ]);
  mockedAdmin.fetchRosterLots.mockResolvedValue([
    { id: 'l1', address: '12 Valley Way' },
    { id: 'l2', address: '14 Valley Way' },
  ]);
  mockedAdmin.fetchElections.mockResolvedValue([]);
});

describe('BoardServicePanel', () => {
  it('shows an empty state when no terms or offices are recorded', async () => {
    mockedRoster.fetchBoardService.mockResolvedValue(service());
    render(<BoardServicePanel />);

    expect(
      await screen.findByText(/no board terms recorded yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no office assignments recorded yet/i),
    ).toBeInTheDocument();
  });

  it('renders the composition advisories in readable terms', async () => {
    mockedRoster.fetchBoardService.mockResolvedValue(
      service({
        terms: [
          term({ id: 't1', personName: 'Dana Reeves' }),
          term({
            id: 't2',
            personId: 'p2',
            personName: 'Sam Okafor',
            scheduledEndDay: '2026-09-30',
          }),
        ],
        advisories: {
          currentMemberCount: 2,
          belowMinimum: true,
          aboveMaximum: false,
          vacantOffices: ['secretary_treasurer'],
          expiringTermIds: ['t2'],
          lapsedTermIds: ['t1'],
        },
      }),
    );
    render(<BoardServicePanel />);

    expect(
      await screen.findByText(/2 current board members/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/below the three-member minimum/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/vacant office: secretary \/ treasurer/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/expiring within thirty days: sam okafor/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/lapsed with no successor recorded: dana reeves/i),
    ).toBeInTheDocument();
  });

  it('records a term from the person and lot pickers', async () => {
    mockedRoster.fetchBoardService.mockResolvedValue(service());
    mockedRoster.createBoardTerm.mockResolvedValue({ id: 't-new' });
    render(<BoardServicePanel />);
    await screen.findByText(/no board terms recorded yet/i);
    // Wait for the pickers, so selecting isn't a race against their fetch.
    await screen.findByRole('option', { name: 'Dana Reeves' });

    await userEvent.selectOptions(screen.getByLabelText(/^person$/i), 'p1');
    await userEvent.selectOptions(
      screen.getByLabelText(/^qualifying lot$/i),
      'l1',
    );
    await userEvent.type(screen.getByLabelText(/^start day$/i), '2026-01-01');
    await userEvent.type(
      screen.getByLabelText(/^scheduled end day$/i),
      '2027-01-01',
    );
    await userEvent.click(screen.getByRole('button', { name: /record term/i }));

    await waitFor(() =>
      expect(mockedRoster.createBoardTerm).toHaveBeenCalledWith({
        personId: 'p1',
        qualifyingLotId: 'l1',
        reasonCode: 'elected',
        startDay: '2026-01-01',
        scheduledEndDay: '2027-01-01',
      }),
    );
    // No election chosen means no key at all, never an empty string.
    expect(mockedRoster.createBoardTerm.mock.calls[0][0]).not.toHaveProperty(
      'electionId',
    );
    expect(await screen.findByText(/term recorded/i)).toBeInTheDocument();
  });

  it('offers the three ending kinds as three distinctly named controls', async () => {
    mockedRoster.fetchBoardService.mockResolvedValue(
      service({ terms: [term()] }),
    );
    mockedRoster.voidBoardTerm.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<BoardServicePanel />);
    await screen.findByRole('button', { name: /void term for dana reeves/i });

    const endBtn = screen.getByRole('button', {
      name: /end term for dana reeves/i,
    });
    const cancelBtn = screen.getByRole('button', {
      name: /cancel term for dana reeves/i,
    });
    const voidBtn = screen.getByRole('button', {
      name: /void term for dana reeves/i,
    });
    expect(endBtn).not.toBe(cancelBtn);
    expect(cancelBtn).not.toBe(voidBtn);

    // Each control carries its own reason set, so none of them is the same
    // action wearing a different label.
    await userEvent.click(endBtn);
    expect(await screen.findByLabelText(/^end reason$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^end day$/i)).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/^cancellation reason$/i),
    ).not.toBeInTheDocument();

    await userEvent.click(cancelBtn);
    expect(
      await screen.findByLabelText(/^cancellation reason$/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^end reason$/i)).not.toBeInTheDocument();

    await userEvent.click(voidBtn);
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(mockedRoster.voidBoardTerm).toHaveBeenCalledWith('t1'),
    );
    expect(mockedRoster.endBoardTerm).not.toHaveBeenCalled();
    expect(mockedRoster.cancelBoardTerm).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('ends a term with its reason and day', async () => {
    mockedRoster.fetchBoardService.mockResolvedValue(
      service({ terms: [term()] }),
    );
    mockedRoster.endBoardTerm.mockResolvedValue(undefined);
    render(<BoardServicePanel />);
    await screen.findByRole('button', { name: /void term for dana reeves/i });

    await userEvent.click(
      screen.getByRole('button', { name: /end term for dana reeves/i }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText(/^end reason$/i),
      'resigned',
    );
    await userEvent.type(screen.getByLabelText(/^end day$/i), '2026-06-30');
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() =>
      expect(mockedRoster.endBoardTerm).toHaveBeenCalledWith({
        termId: 't1',
        reasonCode: 'resigned',
        endDay: '2026-06-30',
      }),
    );
    expect(await screen.findByText(/term ended/i)).toBeInTheDocument();
  });

  it('corrects a term with only the field that changed', async () => {
    mockedRoster.fetchBoardService.mockResolvedValue(
      service({ terms: [term()] }),
    );
    mockedRoster.correctBoardTerm.mockResolvedValue(undefined);
    render(<BoardServicePanel />);
    await screen.findByRole('button', { name: /void term for dana reeves/i });

    await userEvent.click(
      screen.getByRole('button', { name: /correct term for dana reeves/i }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText(/qualifying lot \(correction\)/i),
      'l2',
    );
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() =>
      expect(mockedRoster.correctBoardTerm).toHaveBeenCalledWith('t1', {
        qualifyingLotId: 'l2',
      }),
    );
    // The election link was left alone, so its key must be absent — the route
    // decides by key presence, and `null` would clear the provenance.
    expect(mockedRoster.correctBoardTerm.mock.calls[0][1]).not.toHaveProperty(
      'electionId',
    );
  });

  it('surfaces the qualification refusal verbatim', async () => {
    mockedRoster.fetchBoardService.mockResolvedValue(
      service({ terms: [term()] }),
    );
    mockedRoster.substituteQualifyingLot.mockRejectedValue(
      new Error('Person does not own or represent that lot'),
    );
    render(<BoardServicePanel />);
    await screen.findByRole('button', { name: /void term for dana reeves/i });

    await userEvent.click(
      screen.getByRole('button', {
        name: /substitute qualifying lot for dana reeves/i,
      }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText(/replacement qualifying lot/i),
      'l2',
    );
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(
      await screen.findByText(/does not own or represent that lot/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/409/)).not.toBeInTheDocument();
  });

  it('ends an office assignment', async () => {
    mockedRoster.fetchBoardService.mockResolvedValue(
      service({ terms: [term()], offices: [office()] }),
    );
    mockedRoster.endOffice.mockResolvedValue(undefined);
    render(<BoardServicePanel />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: /end president for dana reeves/i,
      }),
    );
    await userEvent.type(
      await screen.findByLabelText(/end day \(optional\)/i),
      '2026-07-01',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /confirm end office/i }),
    );

    await waitFor(() =>
      expect(mockedRoster.endOffice).toHaveBeenCalledWith({
        assignmentId: 'o1',
        endDay: '2026-07-01',
      }),
    );
    expect(await screen.findByText(/office ended/i)).toBeInTheDocument();
  });
});
