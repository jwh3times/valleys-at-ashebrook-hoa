import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DuesSettings } from '../../lib/types';

vi.mock('../../lib/content', async (orig) => ({
  ...(await orig<typeof import('../../lib/content')>()),
  fetchDuesSettings: vi.fn(),
}));

import DuesInfo from './DuesInfo';
import { fetchDuesSettings } from '../../lib/content';

const dues: DuesSettings = {
  amount: '$250 / year',
  dueDate: 'Due by January 31',
  notes: 'Late fee of $25 after due date.',
  paymentOptions: [
    {
      label: 'PayPal',
      details: 'Send to hoa@example.com',
      url: 'https://paypal.me/hoa',
    },
    { label: 'Mail a check', details: 'PO Box 123' },
  ],
};

describe('DuesInfo', () => {
  beforeEach(() => vi.mocked(fetchDuesSettings).mockReset());

  it('renders the dues amount and payment options', async () => {
    vi.mocked(fetchDuesSettings).mockResolvedValue(dues);
    render(<DuesInfo />);

    expect(await screen.findByText('$250 / year')).toBeInTheDocument();
    expect(screen.getByText('Due by January 31')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'PayPal' })).toBeInTheDocument();
    const payLink = screen.getByRole('link', { name: /pay with paypal/i });
    expect(payLink).toHaveAttribute('href', 'https://paypal.me/hoa');
  });

  it('shows a fallback when no payment options exist', async () => {
    vi.mocked(fetchDuesSettings).mockResolvedValue({
      ...dues,
      paymentOptions: [],
    });
    render(<DuesInfo />);
    expect(
      await screen.findByText(/Payment options will be listed here soon/i),
    ).toBeInTheDocument();
  });
});
