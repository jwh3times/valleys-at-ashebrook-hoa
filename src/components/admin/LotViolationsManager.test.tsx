import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LotViolationsManager from './LotViolationsManager';
import * as admin from '../../lib/admin';
import type { LotViolationDetail, PropertyWithOwners } from '../../lib/types';

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

function violation(
  overrides: Partial<LotViolationDetail> = {},
): LotViolationDetail {
  return {
    id: 'v1',
    lotId: 'lot-a',
    category: 'parking',
    effectiveDay: '2026-09-01',
    summary: 'Boat parked in the street',
    internalNote: null,
    status: 'open',
    createdBy: 'board-1',
    recordedAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  };
}

/** Waits for the list to arrive. The summary is unique; the address is not,
 * because the lot picker lists every address as an option. */
const loaded = () => screen.findByText('Boat parked in the street');

beforeEach(() => {
  vi.resetAllMocks();
  mocked.fetchProperties.mockResolvedValue([
    lot('lot-a', '1 Ashebrook Lane'),
    lot('lot-b', '2 Ashebrook Lane'),
  ]);
  mocked.fetchLotViolations.mockResolvedValue({
    enabled: true,
    rows: [violation()],
  });
});

describe('when the feature is switched off', () => {
  it('explains what lot records are and what has to be turned on', async () => {
    mocked.fetchLotViolations.mockResolvedValue({ enabled: false, rows: [] });
    render(<LotViolationsManager />);

    expect(
      await screen.findByText(/lot records are switched off/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/official mode/i)).toBeInTheDocument();
  });

  it('offers no way to record anything', async () => {
    mocked.fetchLotViolations.mockResolvedValue({ enabled: false, rows: [] });
    render(<LotViolationsManager />);

    await screen.findByText(/lot records are switched off/i);
    expect(
      screen.queryByRole('button', { name: /record violation/i }),
    ).not.toBeInTheDocument();
  });
});

describe('the list', () => {
  it('shows each violation under its lot address, not its id', async () => {
    render(<LotViolationsManager />);
    await loaded();
    // Scoped to the list: the lot picker repeats every address too, and what
    // matters is that the ROW names the home rather than an opaque id.
    const list = within(screen.getByRole('list'));
    expect(list.getByText('1 Ashebrook Lane')).toBeInTheDocument();
    expect(list.queryByText('lot-a')).not.toBeInTheDocument();
    expect(list.getByText('Boat parked in the street')).toBeInTheDocument();
  });

  it('shows an empty state when the lot has no violations', async () => {
    mocked.fetchLotViolations.mockResolvedValue({ enabled: true, rows: [] });
    render(<LotViolationsManager />);
    expect(
      await screen.findByText(/no violations recorded/i),
    ).toBeInTheDocument();
  });

  it('shows the board note, which the homeowner never sees', async () => {
    mocked.fetchLotViolations.mockResolvedValue({
      enabled: true,
      rows: [violation({ internalNote: 'photo on file' })],
    });
    render(<LotViolationsManager />);
    expect(await screen.findByText(/photo on file/i)).toBeInTheDocument();
  });

  it('reloads for one lot when the filter changes', async () => {
    const user = userEvent.setup();
    render(<LotViolationsManager />);
    await loaded();

    await user.selectOptions(
      screen.getByLabelText(/show violations for/i),
      '2 Ashebrook Lane',
    );
    await waitFor(() =>
      expect(mocked.fetchLotViolations).toHaveBeenLastCalledWith('lot-b'),
    );
  });
});

describe('row actions', () => {
  it('names every control with the row it acts on', async () => {
    // A bare "Void" repeated down a list of lots is the one that records a
    // violation against the wrong home.
    render(<LotViolationsManager />);
    await loaded();

    for (const name of [
      'Cured violation: 1 Ashebrook Lane: Boat parked in the street',
      'Close violation: 1 Ashebrook Lane: Boat parked in the street',
      'Correct violation: 1 Ashebrook Lane: Boat parked in the street',
      'Void violation: 1 Ashebrook Lane: Boat parked in the street',
      'History of violation: 1 Ashebrook Lane: Boat parked in the street',
    ])
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });

  it('offers only the transitions the status allows', async () => {
    mocked.fetchLotViolations.mockResolvedValue({
      enabled: true,
      rows: [violation({ status: 'closed' })],
    });
    render(<LotViolationsManager />);
    await loaded();

    expect(
      screen.getByRole('button', { name: /^Reopen violation/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Cured violation/ }),
    ).not.toBeInTheDocument();
  });

  it('offers nothing but history on a voided record', async () => {
    mocked.fetchLotViolations.mockResolvedValue({
      enabled: true,
      rows: [violation({ status: 'voided' })],
    });
    render(<LotViolationsManager />);
    await loaded();

    expect(
      screen.getByRole('button', { name: /^History of violation/ }),
    ).toBeInTheDocument();
    for (const verb of ['Void', 'Correct', 'Reopen', 'Close', 'Cured'])
      expect(
        screen.queryByRole('button', { name: new RegExp(`^${verb} `) }),
      ).not.toBeInTheDocument();
  });

  it('marks a violation cured through the named transition', async () => {
    const user = userEvent.setup();
    mocked.transitionLotViolation.mockResolvedValue(undefined);
    render(<LotViolationsManager />);
    await loaded();

    await user.click(screen.getByRole('button', { name: /^Cured violation/ }));
    await waitFor(() =>
      expect(mocked.transitionLotViolation).toHaveBeenCalledWith('cure', 'v1'),
    );
  });
});

describe('voiding', () => {
  it('asks for a reason before it will void, and says what voiding does', async () => {
    const user = userEvent.setup();
    render(<LotViolationsManager />);
    await loaded();

    await user.click(screen.getByRole('button', { name: /^Void violation/ }));
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(mocked.transitionLotViolation).not.toHaveBeenCalled();
  });

  it('sends the chosen reason code', async () => {
    const user = userEvent.setup();
    mocked.transitionLotViolation.mockResolvedValue(undefined);
    render(<LotViolationsManager />);
    await loaded();

    await user.click(screen.getByRole('button', { name: /^Void violation/ }));
    await user.selectOptions(
      screen.getByLabelText(/reason/i),
      'Duplicate of another record',
    );
    await user.click(
      screen.getByRole('button', { name: /^Confirm voiding violation/ }),
    );

    await waitFor(() =>
      expect(mocked.transitionLotViolation).toHaveBeenCalledWith(
        'void',
        'v1',
        'duplicate',
      ),
    );
  });
});

describe('recording a violation', () => {
  it('requires a lot, a date, and a summary before it will send anything', async () => {
    const user = userEvent.setup();
    render(<LotViolationsManager />);
    await loaded();

    await user.click(
      screen.getByRole('button', { name: /^Record violation$/ }),
    );
    expect(await screen.findByText(/lot, date, and summary/i)).toBeVisible();
    expect(mocked.createLotViolation).not.toHaveBeenCalled();
  });

  it('sends what the board entered, and the lot it chose', async () => {
    const user = userEvent.setup();
    mocked.createLotViolation.mockResolvedValue({ id: 'v2' });
    render(<LotViolationsManager />);
    await loaded();

    await user.selectOptions(
      screen.getByLabelText(/^lot$/i),
      '2 Ashebrook Lane',
    );
    await user.selectOptions(screen.getByLabelText(/category/i), 'Trash');
    await user.type(screen.getByLabelText(/date observed/i), '2026-09-15');
    await user.type(
      screen.getByLabelText(/summary/i),
      'Bins left out past collection',
    );
    await user.click(
      screen.getByRole('button', { name: /^Record violation$/ }),
    );

    await waitFor(() =>
      expect(mocked.createLotViolation).toHaveBeenCalledWith({
        lotId: 'lot-b',
        category: 'trash',
        effectiveDay: '2026-09-15',
        summary: 'Bins left out past collection',
      }),
    );
  });

  it('never offers status as a field to set', async () => {
    // Status moves only through the named transitions; a dropdown here would
    // be the shortest path to a record whose history says nothing.
    render(<LotViolationsManager />);
    await loaded();
    expect(screen.queryByLabelText(/status/i)).not.toBeInTheDocument();
  });
});

describe('correcting a violation', () => {
  it('fills the form from the row and sends an edit, not a create', async () => {
    const user = userEvent.setup();
    mocked.editLotViolation.mockResolvedValue(undefined);
    render(<LotViolationsManager />);
    await loaded();

    await user.click(
      screen.getByRole('button', { name: /^Correct violation/ }),
    );
    const summary = screen.getByLabelText(/summary/i);
    expect(summary).toHaveValue('Boat parked in the street');

    await user.clear(summary);
    await user.type(summary, 'Trailer parked in the street');
    await user.click(screen.getByRole('button', { name: /save correction/i }));

    await waitFor(() =>
      expect(mocked.editLotViolation).toHaveBeenCalledWith(
        'v1',
        expect.objectContaining({ summary: 'Trailer parked in the street' }),
      ),
    );
    expect(mocked.createLotViolation).not.toHaveBeenCalled();
  });

  it('does not let the lot be changed while correcting', async () => {
    // The lot IS the audience: moving it would republish one lot's record to
    // another lot's owners.
    const user = userEvent.setup();
    render(<LotViolationsManager />);
    await loaded();

    await user.click(
      screen.getByRole('button', { name: /^Correct violation/ }),
    );
    expect(screen.getByLabelText(/^lot$/i)).toBeDisabled();
  });
});

describe('history', () => {
  it('shows the record events, newest entry last', async () => {
    const user = userEvent.setup();
    mocked.fetchLotRecordEvents.mockResolvedValue([
      {
        id: 'e1',
        recordType: 'lot_violations',
        recordId: 'v1',
        action: 'created',
        actingAccountId: 'board-1',
        reasonCode: null,
        recordedAt: '2026-09-01T12:00:00.000Z',
      },
      {
        id: 'e2',
        recordType: 'lot_violations',
        recordId: 'v1',
        action: 'cured',
        actingAccountId: 'board-1',
        reasonCode: 'homeowner_corrected',
        recordedAt: '2026-09-05T12:00:00.000Z',
      },
    ]);
    render(<LotViolationsManager />);
    await loaded();

    await user.click(
      screen.getByRole('button', { name: /^History of violation/ }),
    );
    await waitFor(() =>
      expect(mocked.fetchLotRecordEvents).toHaveBeenCalledWith('v1'),
    );
    expect(await screen.findByText(/created/i)).toBeInTheDocument();
    expect(
      screen.getByText(/homeowner corrected the record/i),
    ).toBeInTheDocument();
  });
});

describe('failures', () => {
  it('surfaces the server message rather than a generic one', async () => {
    const user = userEvent.setup();
    mocked.transitionLotViolation.mockRejectedValue(
      new Error(
        'Cannot cure this record — it does not exist, is not in a state this action applies to, or lot records are not enabled',
      ),
    );
    render(<LotViolationsManager />);
    await loaded();

    await user.click(screen.getByRole('button', { name: /^Cured violation/ }));
    expect(
      await screen.findByText(/is not in a state this action applies to/i),
    ).toBeInTheDocument();
  });

  it('reports a failed load without stranding the panel on Loading', async () => {
    mocked.fetchLotViolations.mockRejectedValue(new Error('D1 unavailable'));
    render(<LotViolationsManager />);
    expect(await screen.findByText(/d1 unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Loading/)).not.toBeInTheDocument();
  });
});

describe('the whole panel', () => {
  it('renders one row per violation across lots', async () => {
    mocked.fetchLotViolations.mockResolvedValue({
      enabled: true,
      rows: [
        violation(),
        violation({ id: 'v2', lotId: 'lot-b', summary: 'Bins left out' }),
      ],
    });
    render(<LotViolationsManager />);
    await screen.findByText('Bins left out');

    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });
});
