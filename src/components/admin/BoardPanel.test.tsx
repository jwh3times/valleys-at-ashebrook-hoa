import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BoardPanel from './BoardPanel';
import * as admin from '../../lib/admin';

vi.mock('../../lib/admin');

const mocked = vi.mocked(admin);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('BoardPanel', () => {
  it('shows an empty state when nobody has served', async () => {
    mocked.fetchBoardPeople.mockResolvedValue([]);
    render(<BoardPanel />);
    expect(
      await screen.findByText(/no board members yet/i),
    ).toBeInTheDocument();
  });

  it('lists a person with their office and dates', async () => {
    mocked.fetchBoardPeople.mockResolvedValue([
      {
        id: 'p1',
        fullName: 'A. Reyes',
        userId: null,
        terms: [
          {
            id: 't1',
            personId: 'p1',
            title: 'Treasurer',
            termStart: '2024-01-01',
            termEnd: '2025-12-31',
          },
        ],
      },
    ]);
    render(<BoardPanel />);
    expect(await screen.findByText('A. Reyes')).toBeInTheDocument();
    expect(screen.getByText(/Treasurer/)).toBeInTheDocument();
    expect(screen.getByText(/2024-01-01/)).toBeInTheDocument();
  });

  it('marks an open term as currently serving', async () => {
    mocked.fetchBoardPeople.mockResolvedValue([
      {
        id: 'p1',
        fullName: 'A. Reyes',
        userId: null,
        terms: [
          {
            id: 't1',
            personId: 'p1',
            title: null,
            termStart: '2026-01-01',
            termEnd: null,
          },
        ],
      },
    ]);
    render(<BoardPanel />);
    expect(await screen.findByText(/serving/i)).toBeInTheDocument();
  });

  it('adds a person and reloads', async () => {
    mocked.fetchBoardPeople.mockResolvedValue([]);
    mocked.saveBoardPerson.mockResolvedValue(undefined);
    render(<BoardPanel />);
    await screen.findByText(/no board members yet/i);
    await userEvent.type(screen.getByLabelText(/full name/i), 'A. Reyes');
    await userEvent.click(screen.getByRole('button', { name: /add person/i }));
    await waitFor(() =>
      expect(mocked.saveBoardPerson).toHaveBeenCalledWith(
        { fullName: 'A. Reyes' },
        undefined,
      ),
    );
    expect(await screen.findByText(/person added/i)).toBeInTheDocument();
  });

  it('surfaces the 409 message as readable text when a delete is refused', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocked.fetchBoardPeople.mockResolvedValue([
      {
        id: 'p1',
        fullName: 'A. Reyes',
        userId: null,
        terms: [
          {
            id: 't1',
            personId: 'p1',
            title: null,
            termStart: '2026-01-01',
            termEnd: null,
          },
        ],
      },
    ]);
    mocked.deleteBoardPerson.mockRejectedValue(
      new Error(
        'This person has a term of service on record — remove their terms first.',
      ),
    );
    render(<BoardPanel />);
    await screen.findByText('A. Reyes');
    await userEvent.click(
      screen.getByRole('button', { name: /delete a\. reyes/i }),
    );
    expect(
      await screen.findByText(/remove their terms first/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/409/)).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('does not delete a person when the confirmation is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mocked.fetchBoardPeople.mockResolvedValue([
      {
        id: 'p1',
        fullName: 'A. Reyes',
        userId: null,
        terms: [],
      },
    ]);
    render(<BoardPanel />);
    await screen.findByText('A. Reyes');
    await userEvent.click(
      screen.getByRole('button', { name: /delete a\. reyes/i }),
    );
    expect(confirmSpy).toHaveBeenCalled();
    expect(mocked.deleteBoardPerson).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
