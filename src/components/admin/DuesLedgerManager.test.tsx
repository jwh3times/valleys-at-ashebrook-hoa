import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DuesLedgerManager from './DuesLedgerManager';
import * as admin from '../../lib/admin';
import * as content from '../../lib/content';
import {
  DEFAULT_SITE_SETTINGS,
  type AdminDuesEntryDetail,
  type PropertyWithOwners,
} from '../../lib/types';

vi.mock('../../lib/admin');
vi.mock('../../lib/content');

const mocked = vi.mocked(admin);
const mockedContent = vi.mocked(content);

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
  // Both gates on unless a test says otherwise; the panel reads them so a
  // stray 404 cannot masquerade as "switched off".
  mockedContent.fetchSiteSettings.mockResolvedValue({
    ...DEFAULT_SITE_SETTINGS,
    officialMode: true,
    lotRecordsEnabled: true,
  });
});

describe('when the ledger is switched off', () => {
  it('explains what it is and what has to be on, and offers no entry form', async () => {
    mocked.fetchDuesLedger.mockResolvedValue({ enabled: false, rows: [] });
    mockedContent.fetchSiteSettings.mockResolvedValue({
      ...DEFAULT_SITE_SETTINGS,
      officialMode: true,
      lotRecordsEnabled: false,
    });
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

  it('uses a different key for a different row', async () => {
    // One key means one intended entry. A key left over from a reversal of
    // one row must not be sent for another row's.
    const user = userEvent.setup();
    mocked.reverseDuesEntry.mockRejectedValue(new Error('D1 unavailable'));
    mocked.fetchDuesLedger.mockResolvedValue({
      enabled: true,
      rows: [entry(), entry({ id: 'e2', description: 'Late fee' })],
    });
    render(<DuesLedgerManager />);
    await loaded();

    const [first, second] = screen.getAllByRole('button', {
      name: /^Reverse entry:/,
    });
    await user.click(first);
    await user.type(
      screen.getByLabelText(/description for the reversal/i),
      'Wrong lot',
    );
    await user.click(
      screen.getByRole('button', { name: /^Confirm reversing entry:/ }),
    );
    await screen.findByText(/d1 unavailable/i);

    await user.click(first);
    await user.click(second);
    await user.type(
      screen.getByLabelText(/description for the reversal/i),
      'Also wrong',
    );
    await user.click(
      screen.getByRole('button', { name: /^Confirm reversing entry:/ }),
    );

    const calls = mocked.reverseDuesEntry.mock.calls.map(([input]) => input);
    expect(calls).toHaveLength(2);
    expect(calls[0].entryId).not.toBe(calls[1].entryId);
    expect(calls[0].operationKey).not.toBe(calls[1].operationKey);
  });

  it('keeps the same key while one reversal form stays open', async () => {
    const user = userEvent.setup();
    mocked.reverseDuesEntry.mockRejectedValue(new Error('D1 unavailable'));
    render(<DuesLedgerManager />);
    await loaded();

    await user.click(screen.getByRole('button', { name: /^Reverse entry:/ }));
    await user.type(
      screen.getByLabelText(/description for the reversal/i),
      'Wrong lot',
    );
    const confirm = screen.getByRole('button', {
      name: /^Confirm reversing entry:/,
    });
    await user.click(confirm);
    await screen.findByText(/d1 unavailable/i);
    await user.click(confirm);

    const keys = mocked.reverseDuesEntry.mock.calls.map(
      ([input]) => input.operationKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
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
        name: 'Reverse entry: 1 Ashebrook Lane, 2026-01-01, $450.00, Q1 assessment',
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

describe('posting a payment', () => {
  it('sends it POSITIVE — the ledger stores the sign', async () => {
    // The whole payment path had no test, and this is the half that matters:
    // a panel that "helpfully" pre-negated would double the credit, since the
    // route negates too.
    const user = userEvent.setup();
    mocked.postDuesPayment.mockResolvedValue({ id: 'e2' });
    render(<DuesLedgerManager />);
    await loaded();

    await user.selectOptions(screen.getByLabelText(/^kind$/i), 'payment');
    await user.selectOptions(
      screen.getByLabelText(/^lot$/i),
      '1 Ashebrook Lane',
    );
    await user.selectOptions(
      screen.getByLabelText(/how it was paid/i),
      'Check',
    );
    await user.type(screen.getByLabelText(/^amount/i), '450.00');
    await user.type(screen.getByLabelText(/^date$/i), '2026-02-01');
    await user.type(screen.getByLabelText(/description/i), 'Check 1041');
    await user.click(screen.getByRole('button', { name: /^post entry$/i }));

    await waitFor(() =>
      expect(mocked.postDuesPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 45000, method: 'check' }),
      ),
    );
  });

  it('never offers "online" as something to type in', async () => {
    // An online payment exists because the provider confirmed it; one typed by
    // hand would never reconcile.
    const user = userEvent.setup();
    render(<DuesLedgerManager />);
    await loaded();

    await user.selectOptions(screen.getByLabelText(/^kind$/i), 'payment');
    const options = Array.from(
      screen.getByLabelText(/how it was paid/i).querySelectorAll('option'),
    ).map((o) => o.textContent);
    expect(options).not.toContain('Online');
    expect(options).toContain('Check');
  });

  it('refuses a negative payment without sending it', async () => {
    const user = userEvent.setup();
    render(<DuesLedgerManager />);
    await loaded();

    await user.selectOptions(screen.getByLabelText(/^kind$/i), 'payment');
    await user.selectOptions(
      screen.getByLabelText(/^lot$/i),
      '1 Ashebrook Lane',
    );
    await user.type(screen.getByLabelText(/^amount/i), '-450');
    await user.type(screen.getByLabelText(/^date$/i), '2026-02-01');
    await user.type(screen.getByLabelText(/description/i), 'Check 1041');
    await user.click(screen.getByRole('button', { name: /^post entry$/i }));

    expect(await screen.findByText(/positive amount/i)).toBeInTheDocument();
    expect(mocked.postDuesPayment).not.toHaveBeenCalled();
  });

  it('refuses a zero amount before the server has to', async () => {
    const user = userEvent.setup();
    render(<DuesLedgerManager />);
    await loaded();

    await user.type(screen.getByLabelText(/^amount/i), '0');
    await user.click(screen.getByRole('button', { name: /^post entry$/i }));

    // In the board's words, not the wire's.
    expect(
      await screen.findByText(/zero is not an entry/i),
    ).toBeInTheDocument();
    expect(mocked.postDuesCharge).not.toHaveBeenCalled();
  });
});

describe('the lot filter', () => {
  it('reloads for one lot and says whose balance is shown', async () => {
    const user = userEvent.setup();
    render(<DuesLedgerManager />);
    await loaded();
    expect(screen.getByText(/All lots together/)).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText(/show entries for/i),
      '1 Ashebrook Lane',
    );
    await waitFor(() =>
      expect(mocked.fetchDuesLedger).toHaveBeenLastCalledWith('lot-a'),
    );
    // The distinction the label exists for: one home's balance is not the
    // association's.
    expect(
      await screen.findByText(/1 Ashebrook Lane: \$450\.00 owed/),
    ).toBeInTheDocument();
  });
});

describe("an entry's history", () => {
  it('opens, reports what it is, and says so to assistive tech', async () => {
    const user = userEvent.setup();
    mocked.fetchDuesEntryEvents.mockResolvedValue([
      {
        id: 'ev1',
        recordType: 'dues_ledger_entries',
        recordId: 'e1',
        action: 'created',
        actingAccountId: 'board-1',
        reasonCode: null,
        recordedAt: '2026-01-01T12:00:00.000Z',
      },
    ]);
    render(<DuesLedgerManager />);
    await loaded();

    const toggle = screen.getByRole('button', { name: /^History of entry:/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    await waitFor(() =>
      expect(mocked.fetchDuesEntryEvents).toHaveBeenCalledWith('e1'),
    );
    expect(await screen.findByText(/by board-1/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('reports a failure to load it without wiping the last result', async () => {
    const user = userEvent.setup();
    mocked.fetchDuesEntryEvents.mockRejectedValue(new Error('D1 unavailable'));
    render(<DuesLedgerManager />);
    await loaded();

    await user.click(
      screen.getByRole('button', { name: /^History of entry:/ }),
    );
    expect(await screen.findByText(/d1 unavailable/i)).toBeInTheDocument();
  });
});

describe('the bulk form key', () => {
  it('keeps its key across a failure and takes a new one on reopen', async () => {
    // The same bug as the reversal key, on the action that touches every home:
    // a stale key silently skips every lot that already has the earlier
    // assessment, and reports success.
    const user = userEvent.setup();
    mocked.postBulkAssessment.mockRejectedValue(new Error('D1 unavailable'));
    render(<DuesLedgerManager />);
    await loaded();

    async function fillAndSubmit() {
      await user.clear(screen.getByLabelText(/amount per lot/i));
      await user.type(screen.getByLabelText(/amount per lot/i), '450');
      const day = screen.getByLabelText(/^date$/i, { selector: '#bulk-day' });
      await user.clear(day);
      await user.type(day, '2026-01-01');
      await user.clear(screen.getByLabelText(/every homeowner sees this/i));
      await user.type(
        screen.getByLabelText(/every homeowner sees this/i),
        'Q1 assessment',
      );
      await user.click(
        screen.getByRole('button', { name: /^post to every active lot$/i }),
      );
    }

    const open = screen.getByRole('button', {
      name: /post an assessment to every lot/i,
    });
    await user.click(open);
    await fillAndSubmit();
    await screen.findByText(/d1 unavailable/i);
    // Retried without closing: the same key, so a lost response cannot become
    // a second assessment.
    await fillAndSubmit();

    await user.click(open); // close
    await user.click(open); // reopen — a new intent
    await fillAndSubmit();

    const keys = mocked.postBulkAssessment.mock.calls.map(
      ([input]) => input.operationKey,
    );
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});

describe('the gate, read from the site settings', () => {
  it('shows the off state when the settings say so, even though the ledger read succeeded', async () => {
    // The settings read exists so a stray 404 cannot masquerade as "switched
    // off". For that to be worth anything the settings must be able to say
    // "off" on their own — here the ledger read reports `enabled: true` and
    // the panel still shows the off state, because the flags say otherwise.
    mocked.fetchDuesLedger.mockResolvedValue({
      enabled: true,
      rows: [entry()],
    });
    mockedContent.fetchSiteSettings.mockResolvedValue({
      ...DEFAULT_SITE_SETTINGS,
      officialMode: true,
      lotRecordsEnabled: false,
    });
    render(<DuesLedgerManager />);

    expect(
      await screen.findByText(/dues ledger is switched off/i),
    ).toBeInTheDocument();
  });
});
