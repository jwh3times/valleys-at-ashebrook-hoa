import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import PaymentsManager from './PaymentsManager';
import * as admin from '../../lib/admin';
import type {
  AdminOpenPaymentException,
  AdminPaymentDetail,
  AdminPaymentSummary,
  LotSummary,
} from '../../lib/types';

vi.mock('../../lib/admin');
const mocked = vi.mocked(admin);

/**
 * The board's Payments panel (ADR 0025, #545). Driven as a board member uses
 * it: by visible text and by the accessible names of the row actions, with
 * `fireEvent.change` where typing is not what is being tested.
 */

function lot(id: string, address: string): LotSummary {
  return { id, address, unit: null, status: 'active', voteWeight: 1 };
}

function payment(
  overrides: Partial<AdminPaymentSummary> = {},
): AdminPaymentSummary {
  return {
    id: 'pay-1',
    lotId: 'lot-a',
    amountCents: 45000,
    origin: 'checkout',
    status: 'pending',
    ledgerState: 'none',
    providerPaymentRef: 'cs_test_one',
    createdAt: '2026-11-01T17:00:00.000Z',
    openExceptions: 0,
    ...overrides,
  };
}

function unmatched(
  overrides: Partial<AdminOpenPaymentException> = {},
): AdminOpenPaymentException {
  return {
    id: 'x-unmatched',
    reason: 'unmatched_payment',
    openedAt: '2026-11-02T16:00:00.000Z',
    paymentId: null,
    lotId: null,
    providerPaymentRef: 'cs_link_one',
    fact: {
      type: 'payment_succeeded',
      amountCents: 30000,
      currency: 'usd',
      occurredAt: '2026-11-02T15:00:00.000Z',
    },
    applicable: true,
    ...overrides,
  };
}

const dispute: AdminOpenPaymentException = {
  id: 'x-dispute',
  reason: 'dispute_opened',
  openedAt: '2026-11-03T16:00:00.000Z',
  paymentId: 'pay-1',
  lotId: 'lot-a',
  providerPaymentRef: 'cs_test_one',
  fact: {
    type: 'dispute_opened',
    amountCents: 45000,
    currency: 'usd',
    occurredAt: '2026-11-03T15:00:00.000Z',
  },
  applicable: false,
};

const detail: AdminPaymentDetail = {
  ...payment({ status: 'succeeded', ledgerState: 'credited' }),
  events: [
    {
      id: 'ev-1',
      providerEventId: 'evt_1',
      type: 'payment_succeeded',
      amountCents: 45000,
      currency: 'usd',
      occurredAt: '2026-11-02T15:00:00.000Z',
      receivedAt: '2026-11-02T15:00:05.000Z',
      via: 'webhook',
      outcome: 'applied',
      ledgerEntryId: 'entry-1',
    },
    {
      id: 'ev-2',
      providerEventId: 'evt_2',
      type: 'funds_withdrawn',
      amountCents: 22500,
      currency: 'usd',
      occurredAt: '2026-11-04T15:00:00.000Z',
      receivedAt: '2026-11-04T15:00:05.000Z',
      via: 'webhook',
      outcome: 'exception',
      ledgerEntryId: null,
    },
  ],
  entries: [
    {
      id: 'entry-1',
      kind: 'payment',
      amountCents: -45000,
      effectiveDay: '2026-11-02',
      description: 'Online payment',
      reversesEntryId: null,
    },
  ],
  exceptions: [
    {
      id: 'x-partial',
      reason: 'partial_withdrawal',
      openedAt: '2026-11-04T16:00:00.000Z',
      resolution: {
        resolution: 'corrected_by_entry',
        note: 'Adjusted by hand',
        actingAccountId: 'board-1',
        resolvedAt: '2026-11-05T16:00:00.000Z',
      },
    },
  ],
};

/** The panel has loaded when the payment's reference is on screen. */
const loaded = () =>
  screen.findByText(/cs_test_one/, { selector: '.admin-row-sub' });

beforeEach(() => {
  vi.resetAllMocks();
  let keys = 0;
  mocked.newOperationKey.mockImplementation(() => `key-${++keys}`);
  mocked.fetchLots.mockResolvedValue([
    lot('lot-a', '1 Ashebrook Lane'),
    lot('lot-b', '2 Ashebrook Lane'),
  ]);
  mocked.fetchBoardPayments.mockResolvedValue({
    enabled: true,
    payments: [payment()],
    exceptions: [unmatched(), dispute],
  });
  mocked.fetchBoardPayment.mockResolvedValue(detail);
});

describe('with no payment provider configured', () => {
  it('says so, and offers nothing to act on', async () => {
    mocked.fetchBoardPayments.mockResolvedValue({
      enabled: false,
      payments: [],
      exceptions: [],
    });
    render(<PaymentsManager />);

    expect(
      await screen.findByText(/no payment provider is configured/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the list of payments', () => {
  it('shows each payment with its Lot, amount, status and reference', async () => {
    render(<PaymentsManager />);
    await loaded();

    const row = screen
      .getByRole('button', { name: 'Re-sync payment: cs_test_one' })
      .closest('.panel-card') as HTMLElement;
    expect(within(row).getByText(/\$450\.00 — Processing/)).toBeInTheDocument();
    expect(within(row).getByText(/1 Ashebrook Lane/)).toBeInTheDocument();
  });

  it('filters by Lot and by status', async () => {
    render(<PaymentsManager />);
    await loaded();

    fireEvent.change(screen.getByLabelText(/^show payments for$/i), {
      target: { value: 'lot-b' },
    });
    await waitFor(() =>
      expect(mocked.fetchBoardPayments).toHaveBeenLastCalledWith({
        lotId: 'lot-b',
        status: undefined,
      }),
    );
    fireEvent.change(screen.getByLabelText(/^status$/i), {
      target: { value: 'failed' },
    });
    await waitFor(() =>
      expect(mocked.fetchBoardPayments).toHaveBeenLastCalledWith({
        lotId: 'lot-b',
        status: 'failed',
      }),
    );
  });

  it("keeps the filter's read when a row action's older reload answers last", async () => {
    render(<PaymentsManager />);
    await loaded();
    let answerStale: (
      v: Awaited<ReturnType<typeof admin.fetchBoardPayments>>,
    ) => void = () => {};
    mocked.resyncBoardPayment.mockResolvedValue({ recorded: 0 });
    mocked.fetchBoardPayments
      // The reload after the re-sync, held until the filter's read is in.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerStale = resolve;
          }),
      )
      .mockResolvedValueOnce({
        enabled: true,
        payments: [
          payment({
            id: 'pay-b',
            lotId: 'lot-b',
            providerPaymentRef: 'cs_test_b',
          }),
        ],
        exceptions: [],
      });

    fireEvent.click(
      screen.getByRole('button', { name: 'Re-sync payment: cs_test_one' }),
    );
    await waitFor(() =>
      expect(mocked.fetchBoardPayments).toHaveBeenCalledTimes(2),
    );
    fireEvent.change(screen.getByLabelText(/^show payments for$/i), {
      target: { value: 'lot-b' },
    });
    expect(
      await screen.findByRole('button', { name: 'Re-sync payment: cs_test_b' }),
    ).toBeInTheDocument();

    answerStale({ enabled: true, payments: [payment()], exceptions: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      screen.getByRole('button', { name: 'Re-sync payment: cs_test_b' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Re-sync payment: cs_test_one' }),
    ).not.toBeInTheDocument();
  });
});

describe("a payment's detail", () => {
  it('shows every fact, the entries they wrote, and how each exception closed', async () => {
    render(<PaymentsManager />);
    await loaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Details of payment: cs_test_one' }),
    );

    expect(mocked.fetchBoardPayment).toHaveBeenCalledWith('pay-1');
    expect(
      await screen.findByText(
        /Paid · \$450\.00 · sent by the provider · recorded/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Money taken back · \$225\.00 · sent by the provider · sent to the board/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Online payment/)).toBeInTheDocument();
    expect(
      screen.getByText(/Part of the payment was taken back/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Corrected with a ledger entry.*board-1.*Adjusted by hand/,
      ),
    ).toBeInTheDocument();
  });

  it('shows the last payment whose Details were opened, whichever read answers last', async () => {
    mocked.fetchBoardPayments.mockResolvedValue({
      enabled: true,
      payments: [
        payment(),
        payment({
          id: 'pay-2',
          lotId: 'lot-b',
          providerPaymentRef: 'cs_test_two',
        }),
      ],
      exceptions: [],
    });
    let answerFirst: (v: AdminPaymentDetail) => void = () => {};
    mocked.fetchBoardPayment
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...detail,
        id: 'pay-2',
        lotId: 'lot-b',
        providerPaymentRef: 'cs_test_two',
        events: [],
        entries: [],
        exceptions: [],
      });
    render(<PaymentsManager />);
    await loaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Details of payment: cs_test_one' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Details of payment: cs_test_two' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Details of payment: cs_test_two' }),
      ).toHaveAttribute('aria-expanded', 'true'),
    );
    answerFirst(detail);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      screen.getByRole('button', { name: 'Details of payment: cs_test_one' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Online payment/)).not.toBeInTheDocument();
  });

  it('names a payment with no reference by what its row shows', async () => {
    mocked.fetchBoardPayments.mockResolvedValue({
      enabled: true,
      payments: [payment({ providerPaymentRef: null })],
      exceptions: [],
    });
    render(<PaymentsManager />);
    expect(
      await screen.findByRole('button', {
        name: /^Details of payment: 1 Ashebrook Lane, \$450\.00, started /,
      }),
    ).toBeInTheDocument();
  });

  it('re-syncs one payment and says what was new', async () => {
    mocked.resyncBoardPayment.mockResolvedValue({ recorded: 1 });
    render(<PaymentsManager />);
    await loaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Re-sync payment: cs_test_one' }),
    );

    expect(
      await screen.findByText(/1 new fact recorded from the provider/i),
    ).toBeInTheDocument();
    expect(mocked.resyncBoardPayment).toHaveBeenCalledWith('pay-1');
    // The list is read again, so the row shows what the pull changed.
    expect(mocked.fetchBoardPayments).toHaveBeenCalledTimes(2);
  });

  it('says plainly when a re-sync found nothing new', async () => {
    mocked.resyncBoardPayment.mockResolvedValue({ recorded: 0 });
    render(<PaymentsManager />);
    await loaded();
    fireEvent.click(
      screen.getByRole('button', { name: 'Re-sync payment: cs_test_one' }),
    );
    expect(
      await screen.findByText(/nothing new from the provider/i),
    ).toBeInTheDocument();
  });
});

describe('the exceptions queue', () => {
  it('says why each exception opened', async () => {
    render(<PaymentsManager />);
    await loaded();
    expect(
      screen.getByText(/Money that matches no payment started on this site/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The payer disputed the payment/),
    ).toBeInTheDocument();
  });

  it('resolves one with a reason and a note, under the key its form opened with', async () => {
    mocked.resolvePaymentException.mockResolvedValue({ id: 'key-x' });
    render(<PaymentsManager />);
    await loaded();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Resolve exception: The payer disputed the payment, cs_test_one',
      }),
    );
    const key = mocked.newOperationKey.mock.results.at(-1)?.value as string;
    fireEvent.change(screen.getByLabelText(/^resolution$/i), {
      target: { value: 'corrected_by_entry' },
    });
    fireEvent.change(screen.getByLabelText(/board-only note/i), {
      target: { value: 'Posted an adjustment' },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Confirm resolving exception: The payer disputed the payment, cs_test_one',
      }),
    );

    await waitFor(() =>
      expect(mocked.resolvePaymentException).toHaveBeenCalledWith({
        exceptionId: 'x-dispute',
        resolution: 'corrected_by_entry',
        note: 'Posted an adjustment',
        operationKey: key,
      }),
    );
    expect(await screen.findByText(/exception resolved/i)).toBeInTheDocument();
  });

  it('asks for a note before resolving as "other", and sends nothing', async () => {
    render(<PaymentsManager />);
    await loaded();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Resolve exception: The payer disputed the payment, cs_test_one',
      }),
    );
    fireEvent.change(screen.getByLabelText(/^resolution$/i), {
      target: { value: 'other' },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Confirm resolving exception: The payer disputed the payment, cs_test_one',
      }),
    );

    expect(
      await screen.findByText(/say what was decided/i),
    ).toBeInTheDocument();
    expect(mocked.resolvePaymentException).not.toHaveBeenCalled();
  });

  it('retries a failed resolve under the same key', async () => {
    mocked.resolvePaymentException
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValueOnce({ id: 'key-x' });
    render(<PaymentsManager />);
    await loaded();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Resolve exception: The payer disputed the payment, cs_test_one',
      }),
    );
    const confirm = () =>
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Confirm resolving exception: The payer disputed the payment, cs_test_one',
        }),
      );

    confirm();
    expect(await screen.findByText(/Network down/)).toBeInTheDocument();
    confirm();

    await waitFor(() =>
      expect(mocked.resolvePaymentException).toHaveBeenCalledTimes(2),
    );
    const [first, second] = mocked.resolvePaymentException.mock.calls;
    expect(second?.[0].operationKey).toBe(first?.[0].operationKey);
  });

  it('applies an unmatched payment to the Lot the board chooses', async () => {
    mocked.applyUnmatchedPayment.mockResolvedValue({ paymentId: 'key-x' });
    render(<PaymentsManager />);
    await loaded();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Apply payment to a lot: cs_link_one',
      }),
    );
    const key = mocked.newOperationKey.mock.results.at(-1)?.value as string;
    fireEvent.change(screen.getByLabelText(/^apply to lot$/i), {
      target: { value: 'lot-b' },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Confirm applying payment to a lot: cs_link_one',
      }),
    );

    await waitFor(() =>
      expect(mocked.applyUnmatchedPayment).toHaveBeenCalledWith({
        exceptionId: 'x-unmatched',
        lotId: 'lot-b',
        operationKey: key,
      }),
    );
    expect(
      await screen.findByText(/applied to 2 Ashebrook Lane/i),
    ).toBeInTheDocument();
  });

  it('asks for a Lot before applying, and sends nothing', async () => {
    render(<PaymentsManager />);
    await loaded();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Apply payment to a lot: cs_link_one',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Confirm applying payment to a lot: cs_link_one',
      }),
    );
    expect(await screen.findByText(/choose the lot/i)).toBeInTheDocument();
    expect(mocked.applyUnmatchedPayment).not.toHaveBeenCalled();
  });

  it('offers no apply for an exception the board cannot apply', async () => {
    mocked.fetchBoardPayments.mockResolvedValue({
      enabled: true,
      payments: [payment()],
      exceptions: [dispute, unmatched({ applicable: false })],
    });
    render(<PaymentsManager />);
    await loaded();
    expect(
      screen.queryByRole('button', { name: /^Apply payment to a lot/ }),
    ).not.toBeInTheDocument();
  });
});
