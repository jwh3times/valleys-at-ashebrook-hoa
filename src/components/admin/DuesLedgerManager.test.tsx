import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DuesLedgerManager from './DuesLedgerManager';
import * as admin from '../../lib/admin';
import type { AdminDuesEntryDetail, PropertyWithOwners } from '../../lib/types';

vi.mock('../../lib/admin');

const mocked = vi.mocked(admin);

function lot(id: string, address: string): PropertyWithOwners {
  return {
    id,
    address,
    addressNormalized: address.toLowerCase(),
    unit: null,
    status: 'active',
    voteWeight: 1,
    notes: null,
    owners: [],
  } as unknown as PropertyWithOwners;
}

function entry(
  overrides: Partial<AdminDuesEntryDetail> = {},
): AdminDuesEntryDetail {
  return {
    id: 'e1',
    lotId: 'lot-a',
    kind: 'charge',
    amountCents: 45000,
    effectiveDay: '2026-01-01',
    description: 'Q1 assessment',
    category: 'assessment',
    method: null,
    reference: null,
    source: 'board',
    paymentId: null,
    reversesEntryId: null,
    recordedBy: 'board-1',
    recordedAt: '2026-01-01T12:00:00.000Z',
    operationKey: 'op-1',
    ...overrides,
  };
}

/** The list has loaded when the first entry's description is on screen. */
const loaded = () => screen.findByText('Q1 assessment');

beforeEach(() => {
  vi.resetAllMocks();
  let keys = 0;
  mocked.newOperationKey.mockImplementation(() => `key-${++keys}`);
  mocked.fetchProperties.mockResolvedValue([
    lot('lot-a', '1 Ashebrook Lane'),
    lot('lot-b', '2 Ashebrook Lane'),
  ]);
  mocked.fetchDuesLedger.mockResolvedValue({ enabled: true, rows: [entry()] });
});

describe('when the ledger is switched off', () => {
  it('explains what it is and what has to be on, and offers no entry form', async () => {
    mocked.fetchDuesLedger.mockResolvedValue({ enabled: false, rows: [] });
    render(<DuesLedgerManager />);

    expect(
      await screen.findByText(/dues ledger is switched off/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^post entry$/i }),
    ).not.toBeInTheDocument();
  });
});

describe('the money a board member types', () => {
  it('sends whole cents, exactly', async () => {
    const user = userEvent.setup();
    mocked.postDuesCharge.mockResolvedValue({ id: 'e2' });
    render(<DuesLedgerManager />);
    await loaded();

    await user.selectOptions(
      screen.getByLabelText(/^lot$/i),
      '1 Ashebrook Lane',
    );
    await user.type(screen.getByLabelText(/^amount/i), '450.75');
    await user.type(screen.getByLabelText(/^date$/i), '2026-02-01');
    await user.type(screen.getByLabelText(/description/i), 'Q1 assessment');
    await user.click(screen.getByRole('button', { name: /^post entry$/i }));

    await waitFor(() =>
      expect(mocked.postDuesCharge).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 45075, lotId: 'lot-a' }),
      ),
    );
  });

  it('refuses a blank amount before it sends anything', async () => {
    const user = userEvent.setup();
    render(<DuesLedgerManager />);
    await loaded();

    await user.selectOptions(
      screen.getByLabelText(/^lot$/i),
      '1 Ashebrook Lane',
    );
    await user.type(screen.getByLabelText(/^date$/i), '2026-02-01');
    await user.type(screen.getByLabelText(/description/i), 'Q1 assessment');
    await user.click(screen.getByRole('button', { name: /^post entry$/i }));

    expect(await screen.findByText(/enter an amount/i)).toBeInTheDocument();
    expect(mocked.postDuesCharge).not.toHaveBeenCalled();
  });

  it('refuses a third decimal place rather than rounding it away', async () => {
    const user = userEvent.setup();
    render(<DuesLedgerManager />);
    await loaded();

    await user.type(screen.getByLabelText(/^amount/i), '450.755');
    await user.click(screen.getByRole('button', { name: /^post entry$/i }));

    expect(await screen.findByText(/two decimal places/i)).toBeInTheDocument();
    expect(mocked.postDuesCharge).not.toHaveBeenCalled();
  });

  it('refuses a negative charge but allows a negative adjustment', async () => {
    const user = userEvent.setup();
    mocked.postDuesAdjustment.mockResolvedValue({ id: 'e3' });
    render(<DuesLedgerManager />);
    await loaded();

    await user.selectOptions(
      screen.getByLabelText(/^lot$/i),
      '1 Ashebrook Lane',
    );
    await user.type(screen.getByLabelText(/^amount/i), '-45.00');
    await user.type(screen.getByLabelText(/^date$/i), '2026-02-01');
    await user.type(screen.getByLabelText(/description/i), 'Waiver');
    await user.click(screen.getByRole('button', { name: /^post entry$/i }));
    expect(await screen.findByText(/positive amount/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/^kind$/i), 'adjustment');
    await user.click(screen.getByRole('button', { name: /^post entry$/i }));
    await waitFor(() =>
      expect(mocked.postDuesAdjustment).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: -4500 }),
      ),
    );
  });
});

describe('the operation key', () => {
  it('sends the same key when a failed post is retried', async () => {
    // A retry must not become a second entry, so the key survives a failure.
    const user = userEvent.setup();
    mocked.postDuesCharge.mockRejectedValue(new Error('D1 unavailable'));
    render(<DuesLedgerManager />);
    await loaded();

    await user.selectOptions(
      screen.getByLabelText(/^lot$/i),
      '1 Ashebrook Lane',
    );
    await user.type(screen.getByLabelText(/^amount/i), '450');
    await user.type(screen.getByLabelText(/^date$/i), '2026-02-01');
    await user.type(screen.getByLabelText(/description/i), 'Q1');
    await user.click(screen.getByRole('button', { name: /^post entry$/i }));
    await screen.findByText(/d1 unavailable/i);
    await user.click(screen.getByRole('button', { name: /^post entry$/i }));

    const keys = mocked.postDuesCharge.mock.calls.map(
      ([input]) => input.operationKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('takes a fresh key after a post succeeds', async () => {
    const user = userEvent.setup();
    mocked.postDuesCharge.mockResolvedValue({ id: 'e2' });
    render(<DuesLedgerManager />);
    await loaded();

    async function postOne(description: string) {
      await user.selectOptions(
        screen.getByLabelText(/^lot$/i),
        '1 Ashebrook Lane',
      );
      await user.clear(screen.getByLabelText(/^amount/i));
      await user.type(screen.getByLabelText(/^amount/i), '450');
      await user.type(screen.getByLabelText(/^date$/i), '2026-02-01');
      await user.clear(screen.getByLabelText(/description/i));
      await user.type(screen.getByLabelText(/description/i), description);
      await user.click(screen.getByRole('button', { name: /^post entry$/i }));
    }

    await postOne('First');
    await waitFor(() => expect(mocked.postDuesCharge).toHaveBeenCalledTimes(1));
    await postOne('Second');
    await waitFor(() => expect(mocked.postDuesCharge).toHaveBeenCalledTimes(2));

    const keys = mocked.postDuesCharge.mock.calls.map(
      ([input]) => input.operationKey,
    );
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('the list', () => {
  it('shows amounts as dollars and the balance in words', async () => {
    mocked.fetchDuesLedger.mockResolvedValue({
      enabled: true,
      rows: [
        entry(),
        entry({
          id: 'e2',
          kind: 'payment',
          amountCents: -20000,
          description: 'Check 1041',
          category: null,
          method: 'check',
        }),
      ],
    });
    render(<DuesLedgerManager />);
    await loaded();

    expect(screen.getByText(/\$450\.00 — Charge/)).toBeInTheDocument();
    expect(screen.getByText(/-\$200\.00 — Payment/)).toBeInTheDocument();
    // 45000 - 20000 = 25000 owed, said rather than signed.
    expect(screen.getByText(/\$250\.00 owed/)).toBeInTheDocument();
  });

  it('says whose balance it is showing', async () => {
    render(<DuesLedgerManager />);
    await loaded();
    expect(screen.getByText(/All lots together/)).toBeInTheDocument();
  });

  it('shows a credit as a credit, not as a negative debt', async () => {
    mocked.fetchDuesLedger.mockResolvedValue({
      enabled: true,
      rows: [
        entry({
          kind: 'payment',
          amountCents: -45000,
          description: 'Q1 assessment',
          category: null,
          method: 'check',
        }),
      ],
    });
    render(<DuesLedgerManager />);
    await loaded();
    expect(screen.getByText(/\$450\.00 in credit/)).toBeInTheDocument();
  });

  it('marks the board-only reference as board-only', async () => {
    mocked.fetchDuesLedger.mockResolvedValue({
      enabled: true,
      rows: [entry({ reference: 'check 1041' })],
    });
    render(<DuesLedgerManager />);
    await loaded();
    // The form's own label says this too, so the ROW's marker is what is
    // asserted: the reference and its warning travel together.
    const marker = screen
      .getAllByText(/never shown to the homeowner/i)
      .find((el) => el.textContent?.includes('check 1041'));
    expect(marker).toBeDefined();
  });

  it('never claims an empty ledger when the read failed', async () => {
    mocked.fetchDuesLedger.mockRejectedValue(new Error('D1 unavailable'));
    render(<DuesLedgerManager />);
    await screen.findByText(/d1 unavailable/i);
    expect(screen.queryByText(/no entries yet/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^post entry$/i }),
    ).not.toBeInTheDocument();
  });
});

describe('reversing an entry', () => {
  it('says what reversing does, and what it will post, before it acts', async () => {
    const user = userEvent.setup();
    render(<DuesLedgerManager />);
    await loaded();

    await user.click(screen.getByRole('button', { name: /^Reverse entry:/ }));
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    // The exact opposite entry, named before the click.
    expect(screen.getByText(/-\$450\.00/)).toBeInTheDocument();
    expect(mocked.reverseDuesEntry).not.toHaveBeenCalled();
  });

  it('requires a description the homeowner will read', async () => {
    const user = userEvent.setup();
    render(<DuesLedgerManager />);
    await loaded();

    await user.click(screen.getByRole('button', { name: /^Reverse entry:/ }));
    await user.click(
      screen.getByRole('button', { name: /^Confirm reversing entry:/ }),
    );
    expect(await screen.findByText(/say why/i)).toBeInTheDocument();
    expect(mocked.reverseDuesEntry).not.toHaveBeenCalled();
  });

  it('sends the reversal once a description is given', async () => {
    const user = userEvent.setup();
    mocked.reverseDuesEntry.mockResolvedValue({ id: 'r1' });
    render(<DuesLedgerManager />);
    await loaded();

    await user.click(screen.getByRole('button', { name: /^Reverse entry:/ }));
    await user.type(
      screen.getByLabelText(/description for the reversal/i),
      'Posted to the wrong lot',
    );
    await user.click(
      screen.getByRole('button', { name: /^Confirm reversing entry:/ }),
    );

    await waitFor(() =>
      expect(mocked.reverseDuesEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          entryId: 'e1',
          description: 'Posted to the wrong lot',
        }),
      ),
    );
  });

  it('offers no reversal for a reversal or for a provider row', async () => {
    mocked.fetchDuesLedger.mockResolvedValue({
      enabled: true,
      rows: [
        entry({ kind: 'reversal', reversesEntryId: 'e0', category: null }),
        entry({
          id: 'e2',
          source: 'provider',
          kind: 'payment',
          amountCents: -45000,
          category: null,
          method: 'online',
          recordedBy: null,
          description: 'Paid online',
        }),
      ],
    });
    render(<DuesLedgerManager />);
    await loaded();

    expect(
      screen.queryByRole('button', { name: /^Reverse entry:/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /^History of entry:/ }),
    ).toHaveLength(2);
  });
});

describe('row controls', () => {
  it('name the row they act on', async () => {
    render(<DuesLedgerManager />);
    await loaded();

    expect(
      screen.getByRole('button', {
        name: 'Reverse entry: 1 Ashebrook Lane, 2026-01-01, $450.00',
      }),
    ).toBeInTheDocument();
  });
});

describe('the bulk assessment', () => {
  it('explains that re-running it is safe, and reports how many lots it reached', async () => {
    const user = userEvent.setup();
    mocked.postBulkAssessment.mockResolvedValue({ posted: 2 });
    render(<DuesLedgerManager />);
    await loaded();

    await user.click(
      screen.getByRole('button', { name: /post an assessment to every lot/i }),
    );
    expect(screen.getByText(/re-running it is safe/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/amount per lot/i), '450');
    await user.type(
      screen.getByLabelText(/^date$/i, { selector: '#bulk-day' }),
      '2026-01-01',
    );
    await user.type(
      screen.getByLabelText(/every homeowner sees this/i),
      'Q1 assessment',
    );
    await user.click(
      screen.getByRole('button', { name: /^post to every active lot$/i }),
    );

    await waitFor(() =>
      expect(mocked.postBulkAssessment).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 45000 }),
      ),
    );
    expect(await screen.findByText(/posted to 2 lots/i)).toBeInTheDocument();
  });
});
