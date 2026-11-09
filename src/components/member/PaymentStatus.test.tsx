import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import PaymentStatus, { REFRESH_DELAYS_MS } from './PaymentStatus';
import * as member from '../../lib/member';

vi.mock('../../lib/member');
const mocked = vi.mocked(member);

const ACH_NOTE = /bank payments take several business days to settle/i;
const STOPPED = /stopped checking/i;

/** Every wait the island makes, one after another. */
const ALL_TRIES_MS = REFRESH_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

/**
 * Lets `ms` pass, a second at a time: React schedules the next check from an
 * effect, which runs only when `act` returns, so one long advance would skip
 * every check after the first.
 */
async function wait(ms: number) {
  for (let left = ms; left > 0; left -= 1000)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(left, 1000));
    });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PaymentStatus', () => {
  it('shows the stored status and the bank-payment note before checking anything', () => {
    render(
      <PaymentStatus
        paymentId="pay-1"
        amountCents={45075}
        status="pending"
        ledgerState="none"
      />,
    );

    expect(screen.getByText(/\$450\.75/)).toHaveTextContent('Processing');
    expect(screen.getByText(ACH_NOTE)).toBeInTheDocument();
    expect(mocked.refreshDuesPayment).not.toHaveBeenCalled();
  });

  it('keeps checking a processing payment and shows it confirmed once the provider confirms', async () => {
    mocked.refreshDuesPayment
      .mockResolvedValueOnce({ status: 'pending', ledgerState: 'none' })
      .mockResolvedValueOnce({ status: 'succeeded', ledgerState: 'credited' });
    render(
      <PaymentStatus
        paymentId="pay-1"
        amountCents={45075}
        status="pending"
        ledgerState="none"
      />,
    );

    await wait(REFRESH_DELAYS_MS[0]!);
    expect(mocked.refreshDuesPayment).toHaveBeenCalledWith('pay-1');
    expect(screen.getByText(/\$450\.75/)).toHaveTextContent('Processing');

    await wait(REFRESH_DELAYS_MS[1]!);
    expect(screen.getByText(/\$450\.75/)).toHaveTextContent('Received');
    expect(screen.getByRole('status')).toHaveTextContent(
      'confirmed this payment',
    );
    expect(screen.queryByText(ACH_NOTE)).not.toBeInTheDocument();

    await wait(ALL_TRIES_MS);
    expect(mocked.refreshDuesPayment).toHaveBeenCalledTimes(2);
  });

  it('checks a payment the provider has not confirmed yet, and stops once it is canceled', async () => {
    mocked.refreshDuesPayment.mockResolvedValue({
      status: 'canceled',
      ledgerState: 'none',
    });
    render(
      <PaymentStatus
        paymentId="pay-1"
        amountCents={45075}
        status="created"
        ledgerState="none"
      />,
    );

    await wait(ALL_TRIES_MS);

    expect(mocked.refreshDuesPayment).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/\$450\.75/)).toHaveTextContent('Canceled');
  });

  it('stops after a bounded number of tries, and says so', async () => {
    mocked.refreshDuesPayment.mockResolvedValue({
      status: 'pending',
      ledgerState: 'none',
    });
    render(
      <PaymentStatus
        paymentId="pay-1"
        amountCents={45075}
        status="pending"
        ledgerState="none"
      />,
    );

    await wait(ALL_TRIES_MS - 1);
    expect(screen.queryByText(STOPPED)).not.toBeInTheDocument();
    await wait(1);
    expect(mocked.refreshDuesPayment).toHaveBeenCalledTimes(
      REFRESH_DELAYS_MS.length,
    );
    expect(screen.getByText(STOPPED)).toBeInTheDocument();
    expect(screen.getByText(ACH_NOTE)).toBeInTheDocument();

    await wait(10 * ALL_TRIES_MS);
    expect(mocked.refreshDuesPayment).toHaveBeenCalledTimes(
      REFRESH_DELAYS_MS.length,
    );
  });

  it('counts a check that fails as a try and carries on', async () => {
    mocked.refreshDuesPayment
      .mockRejectedValueOnce(
        new Error('The payment service could not be reached.'),
      )
      .mockResolvedValueOnce({ status: 'succeeded', ledgerState: 'credited' });
    render(
      <PaymentStatus
        paymentId="pay-1"
        amountCents={45075}
        status="pending"
        ledgerState="none"
      />,
    );

    await wait(REFRESH_DELAYS_MS[0]! + REFRESH_DELAYS_MS[1]!);

    expect(mocked.refreshDuesPayment).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/\$450\.75/)).toHaveTextContent('Received');
  });

  it.each([
    ['succeeded', 'none', 'Received'],
    ['failed', 'none', 'Did not go through'],
    ['succeeded', 'withdrawn', 'Withdrawn'],
  ] as const)(
    'never checks a payment that is already %s (%s)',
    async (status, ledgerState, label) => {
      render(
        <PaymentStatus
          paymentId="pay-1"
          amountCents={45075}
          status={status}
          ledgerState={ledgerState}
        />,
      );

      await wait(ALL_TRIES_MS);

      expect(mocked.refreshDuesPayment).not.toHaveBeenCalled();
      expect(screen.getByText(/\$450\.75/)).toHaveTextContent(label);
      expect(screen.queryByText(ACH_NOTE)).not.toBeInTheDocument();
    },
  );
});
