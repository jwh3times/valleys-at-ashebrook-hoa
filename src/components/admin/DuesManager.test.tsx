import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../lib/content', () => ({
  fetchDuesSettings: vi.fn().mockResolvedValue({
    amount: '$125',
    dueDate: '2027-01-01',
    notes: '',
    paymentOptions: [
      { label: 'Pay by check', details: 'Mail a check.', url: '' },
    ],
  }),
}));
vi.mock('../../lib/admin', () => ({ saveDues: vi.fn() }));

import DuesManager from './DuesManager';

describe('DuesManager', () => {
  it('names a remove action with its payment option', async () => {
    render(<DuesManager />);

    expect(
      await screen.findByRole('button', {
        name: 'Remove payment option: Pay by check',
      }),
    ).toBeInTheDocument();
  });
});
