import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchProperties = vi.fn();
const saveProperty = vi.fn().mockResolvedValue(undefined);
const saveOwner = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  fetchProperties: (...a: unknown[]) => fetchProperties(...a),
  saveProperty: (...a: unknown[]) => saveProperty(...a),
  saveOwner: (...a: unknown[]) => saveOwner(...a),
}));

import RosterManager from './RosterManager';

const HOME = {
  id: 'p1',
  address: '1 Test St',
  unit: null,
  status: 'active' as const,
  notes: null,
  owners: [
    {
      id: 'o1',
      propertyId: 'p1',
      fullName: 'Jane Doe',
      phone: '+15551234567',
      email: 'jane@x.com',
      status: 'active' as const,
      notes: null,
    },
  ],
};

beforeEach(() => {
  fetchProperties.mockReset().mockResolvedValue([HOME]);
  saveProperty.mockClear();
  saveOwner.mockClear();
});

describe('RosterManager', () => {
  it('renders homes with their owners', async () => {
    render(<RosterManager />);
    expect(await screen.findByText('1 Test St')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('adds an owner to a home with the correct propertyId', async () => {
    render(<RosterManager />);
    fireEvent.click(
      await screen.findByRole('button', { name: /add owner to/i }),
    );
    fireEvent.change(screen.getByLabelText(/full name/i), {
      target: { value: 'John Roe' },
    });
    fireEvent.change(screen.getByLabelText(/owner notes/i), {
      target: { value: 'Prefers email' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^add owner$/i }));
    await waitFor(() => expect(saveOwner).toHaveBeenCalledTimes(1));
    expect(saveOwner.mock.calls[0][0]).toMatchObject({
      propertyId: 'p1',
      fullName: 'John Roe',
      notes: 'Prefers email',
    });
    expect(saveOwner.mock.calls[0][1]).toBeUndefined(); // create (no id)
  });

  it('deactivates an owner via a status PATCH', async () => {
    render(<RosterManager />);
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('button', { name: /deactivate owner/i }));
    await waitFor(() => expect(saveOwner).toHaveBeenCalledTimes(1));
    expect(saveOwner.mock.calls[0][0]).toMatchObject({ status: 'inactive' });
    expect(saveOwner.mock.calls[0][1]).toBe('o1'); // patch by id
  });
});

describe('RosterManager — vote weight', () => {
  it('omits the weight from a home row when it is 1', async () => {
    fetchProperties.mockReset().mockResolvedValue([{ ...HOME, voteWeight: 1 }]);
    render(<RosterManager />);
    const row = await screen.findByText('1 Test St');
    expect(row.textContent).toBe('1 Test St');
  });

  it('shows the weight on a home row when it is not 1', async () => {
    fetchProperties.mockReset().mockResolvedValue([{ ...HOME, voteWeight: 3 }]);
    render(<RosterManager />);
    const row = await screen.findByText(/1 Test St/);
    expect(row.textContent).toBe('1 Test St · Weight 3');
  });

  it('pre-fills the vote weight field when editing a home', async () => {
    fetchProperties.mockReset().mockResolvedValue([{ ...HOME, voteWeight: 4 }]);
    render(<RosterManager />);
    await screen.findByText(/1 Test St/);
    // The home's own "Edit" button is the first — owners have one too.
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const input = screen.getByLabelText(/vote weight/i) as HTMLInputElement;
    expect(input.value).toBe('4');
  });

  it('sends the edited vote weight on save', async () => {
    fetchProperties.mockReset().mockResolvedValue([{ ...HOME, voteWeight: 1 }]);
    render(<RosterManager />);
    await screen.findByText(/1 Test St/);
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    fireEvent.change(screen.getByLabelText(/vote weight/i), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save home/i }));
    await waitFor(() => expect(saveProperty).toHaveBeenCalledTimes(1));
    expect(saveProperty.mock.calls[0][0]).toMatchObject({ voteWeight: 7 });
    expect(saveProperty.mock.calls[0][1]).toBe('p1'); // patch by id
  });
});
