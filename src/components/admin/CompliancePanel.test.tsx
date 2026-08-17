import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AccessDenialRow,
  AuditIntegrityView,
  RedactionsView,
} from '../../lib/roster-admin';

// A PARTIAL mock: the reads and writes are stubbed, but `isCapabilityRefusal`
// stays real, because the whole point of the capability card is that the panel
// and the helper module agree on what a refusal looks like. Stubbing the
// predicate too would let that agreement rot and still pass.
const h = vi.hoisted(() => ({
  fetchRedactions: vi.fn(),
  fetchAccessDenials: vi.fn(),
  fetchAuditIntegrity: vi.fn(),
  redactPersonName: vi.fn(),
  redactContactMethod: vi.fn(),
  recordRedactionCleanup: vi.fn(),
}));

vi.mock('../../lib/roster-admin', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../lib/roster-admin')>();
  return { ...actual, ...h };
});

import CompliancePanel from './CompliancePanel';

const AUG_2026 = Date.UTC(2026, 7, 1, 16, 30);

const redactions: RedactionsView = {
  compliance: [
    {
      event_id: 'ev-1',
      recorded_at: AUG_2026,
      performed_by_account_id: 'acct-admin',
      target_person_id: 'person-1',
      target_contact_method_id: null,
      field_category: 'person_name',
      authorized_by_account_id: 'acct-admin',
      authority_kind: 'legal_requirement',
      authority_reference: 'NCGS 47F-3-118',
      reason_code: 'resident_request',
      task_count: 1,
      tasks_pending: 1,
      tasks_failed: 0,
    },
  ],
  tasks: [
    {
      id: 'task-1',
      redaction_event_id: 'ev-1',
      target_kind: 'pseudonymizer_catalog',
      target_identifier: 'person-1',
      status: 'pending',
      attempts: 0,
      last_error_code: null,
      created_at: AUG_2026,
      completed_at: null,
    },
  ],
};

const denials: AccessDenialRow[] = [
  {
    id: 'ev-2',
    recorded_at: AUG_2026,
    actor_account_id: 'acct-admin',
    event_kind: 'access_revoked',
    access_grant_id: 'grant-1',
    target_account_id: 'acct-other',
    grant_type: 'system_admin',
    requested_action: 'revoke',
    reason_code: 'last_system_administrator',
  },
];

const clean: AuditIntegrityView = {
  auditViolations: [],
  boardEligibilityViolations: [],
};

function authorized() {
  h.fetchRedactions.mockResolvedValue(redactions);
  h.fetchAccessDenials.mockResolvedValue(denials);
  h.fetchAuditIntegrity.mockResolvedValue(clean);
}

function forbidden() {
  // What every caller gets while `cutover_mode` reads `legacy`: the shared
  // capability gate's bare plain-text 403.
  h.fetchRedactions.mockRejectedValue(new Error('Forbidden'));
  h.fetchAccessDenials.mockRejectedValue(new Error('Forbidden'));
  h.fetchAuditIntegrity.mockRejectedValue(new Error('Forbidden'));
}

describe('CompliancePanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.redactPersonName.mockResolvedValue(undefined);
    h.redactContactMethod.mockResolvedValue(undefined);
    h.recordRedactionCleanup.mockResolvedValue(undefined);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
  });

  it('explains itself instead of erroring when the caller lacks the capability', async () => {
    forbidden();
    render(<CompliancePanel />);

    expect(
      await screen.findByText(/requires system administrator access/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/granted at the adr 0022 cutover/i),
    ).toBeInTheDocument();
    // The refusal is explained, not surfaced as a failure, and no write
    // affordance is offered to a caller who cannot use it.
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /redact permanently/i }),
    ).not.toBeInTheDocument();
  });

  it('shows redactions, access denials, and audit integrity when authorized', async () => {
    authorized();
    render(<CompliancePanel />);

    expect(await screen.findByText('Redactions')).toBeInTheDocument();
    expect(screen.getByText(/NCGS 47F-3-118/)).toBeInTheDocument();
    expect(screen.getByText('Cleanup tasks')).toBeInTheDocument();
    expect(screen.getByText(/pseudonymizer catalog/i)).toBeInTheDocument();

    expect(screen.getByText('Access denials')).toBeInTheDocument();
    expect(screen.getByText(/revoke access/i)).toBeInTheDocument();
    expect(screen.getByText(/last_system_administrator/)).toBeInTheDocument();

    expect(screen.getByText('Audit integrity')).toBeInTheDocument();
    expect(
      screen.getByText(/no integrity violations.*expected, healthy state/is),
    ).toBeInTheDocument();
  });

  it('names the two integrity views when they do report violations', async () => {
    authorized();
    h.fetchAuditIntegrity.mockResolvedValue({
      auditViolations: [
        { event_id: 'ev-9', violation: 'detail_cardinality' as const },
      ],
      boardEligibilityViolations: [
        {
          board_term_id: 'term-1',
          person_id: 'person-2',
          qualifying_lot_id: 'lot-1',
          violation: 'qualifying_basis_missing' as const,
        },
      ],
    } satisfies AuditIntegrityView);
    render(<CompliancePanel />);

    expect(await screen.findByText(/detail_cardinality/)).toBeInTheDocument();
    expect(screen.getByText(/qualifying_basis_missing/)).toBeInTheDocument();
    expect(
      screen.queryByText(/no integrity violations/i),
    ).not.toBeInTheDocument();
  });

  it('redacts only after a confirm that says the change is irreversible', async () => {
    authorized();
    // Typed with its message parameter so the assertions below can read the
    // wording the administrator was actually shown.
    const confirmMock = vi.fn((_message: string) => false);
    vi.stubGlobal('confirm', confirmMock);
    render(<CompliancePanel />);
    await screen.findByText('Redactions');

    await userEvent.type(screen.getByLabelText(/person id/i), 'person-1');
    await userEvent.type(
      screen.getByLabelText(/statute, policy, or order/i),
      'NCGS 47F-3-118',
    );
    await userEvent.type(
      screen.getByLabelText(/reason code/i),
      'resident_request',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /redact permanently/i }),
    );

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatch(/irreversible/i);
    expect(confirmMock.mock.calls[0][0]).toMatch(
      /permanently removed for every viewer/i,
    );
    expect(h.redactPersonName).not.toHaveBeenCalled();

    confirmMock.mockReturnValue(true);
    await userEvent.click(
      screen.getByRole('button', { name: /redact permanently/i }),
    );

    await waitFor(() =>
      expect(h.redactPersonName).toHaveBeenCalledWith({
        personId: 'person-1',
        authorityKind: 'legal_requirement',
        authorityReference: 'NCGS 47F-3-118',
        reason: 'resident_request',
      }),
    );
  });

  it('records a cleanup outcome without a confirm', async () => {
    authorized();
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmMock);
    render(<CompliancePanel />);

    await userEvent.click(
      await screen.findByRole('button', { name: /record purged/i }),
    );

    await waitFor(() =>
      expect(h.recordRedactionCleanup).toHaveBeenCalledWith({
        taskId: 'task-1',
        status: 'succeeded',
      }),
    );
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("surfaces the server's own message when a write is refused", async () => {
    authorized();
    h.recordRedactionCleanup.mockRejectedValue(
      new Error('Task already succeeded'),
    );
    render(<CompliancePanel />);

    await userEvent.click(
      await screen.findByRole('button', { name: /record purged/i }),
    );

    expect(
      await screen.findByText(/Error: Task already succeeded/),
    ).toBeInTheDocument();
  });
});
