import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DuesSettings } from '../../lib/types';
import DuesInfo from './DuesInfo';

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
  it('renders the dues amount and payment options from props', () => {
    render(<DuesInfo dues={dues} />);
    expect(screen.getByText('$250 / year')).toBeInTheDocument();
    expect(screen.getByText('Due by January 31')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'PayPal' })).toBeInTheDocument();
    const payLink = screen.getByRole('link', { name: /pay with paypal/i });
    expect(payLink).toHaveAttribute('href', 'https://paypal.me/hoa');
  });

  it('shows a fallback when no payment options exist', () => {
    render(<DuesInfo dues={{ ...dues, paymentOptions: [] }} />);
    expect(
      screen.getByText(/Payment options will be listed here soon/i),
    ).toBeInTheDocument();
  });
});
