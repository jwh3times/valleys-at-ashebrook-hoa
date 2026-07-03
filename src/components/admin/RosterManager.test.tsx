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
