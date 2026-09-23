import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as admin from '../../src/lib/admin';

/**
 * The admin write helpers had no direct test at all — every component test
 * mocks the module wholesale, so the mock and the real thing could drift
 * silently, and 22 of the 63 error branches discarded the server's message
 * without anything noticing.
 *
 * This pins the contract: a failed admin call throws the server's own text.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body || '{}'),
  };
}

/**
 * One representative per endpoint family, chosen so every family is covered
 * and so the list includes several helpers that previously threw a bare
 * status code.
 */
const CALLS: Array<[string, () => Promise<unknown>]> = [
  ['deleteAnnouncement', () => admin.deleteAnnouncement('a1')],
  ['editDocument', () => admin.editDocument('d1', { title: 'x' })],
  ['deleteDocument', () => admin.deleteDocument('d1')],
  ['resolveDuplicates', () => admin.resolveDuplicates(['k'], ['d'])],
  ['saveDues', () => admin.saveDues({} as never)],
  ['saveSite', () => admin.saveSite({} as never)],
  ['deleteMeeting', () => admin.deleteMeeting('m1')],
  ['deleteMotion', () => admin.deleteMotion('mo1')],
  ['deleteResolution', () => admin.deleteResolution('r1')],
  ['deleteElection', () => admin.deleteElection('e1')],
  ['deleteProxy', () => admin.deleteProxy('x1')],
  ['saveMeeting', () => admin.saveMeeting({} as never)],
  ['setMemberAttendance', () => admin.setMemberAttendance('m1', [])],
  ['createLotViolation', () => admin.createLotViolation({} as never)],
  ['transitionLotViolation', () => admin.transitionLotViolation('cure', 'v1')],
  ['editLotViolation', () => admin.editLotViolation('v1', { summary: 'x' })],
  ['fetchLotRecordEvents', () => admin.fetchLotRecordEvents('v1')],
];

describe('admin write helpers surface the server message', () => {
  for (const [name, call] of CALLS) {
    it(`${name} throws the server's text`, async () => {
      fetchMock.mockResolvedValue(
        respond(
          409,
          'Proxy is in use (attendance) — remove those records first',
        ),
      );
      await expect(call()).rejects.toThrow(
        'Proxy is in use (attendance) — remove those records first',
      );
    });
  }

  it('falls back to a status message only when the body is empty', async () => {
    fetchMock.mockResolvedValue(respond(500, ''));
    await expect(admin.deleteAnnouncement('a1')).rejects.toThrow(/500/);
  });

  it('never swallows a message behind a bare status code', async () => {
    // The specific regression: `Delete failed: 409` instead of the reason.
    fetchMock.mockResolvedValue(respond(409, 'Meeting is approved'));
    await expect(admin.deleteMeeting('m1')).rejects.toThrow(
      'Meeting is approved',
    );
    await expect(admin.deleteMeeting('m1')).rejects.not.toThrow(
      /^Delete failed/,
    );
  });
});

describe('request shapes', () => {
  it('sends a create as POST and an update as PATCH with the id folded in', async () => {
    fetchMock.mockResolvedValue(respond(204));

    await admin.saveResolution({ title: 'A' } as never);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/resolutions');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ title: 'A' });

    await admin.saveResolution({ title: 'B' } as never, 'r1');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      id: 'r1',
      title: 'B',
    });
  });

  it('sends action endpoints as a POST carrying the action name', async () => {
    fetchMock.mockResolvedValue(respond(204));
    await admin.approveMeeting('m1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/meetings');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ action: 'approve' });
  });

  it('returns the new id from a create that reports one', async () => {
    fetchMock.mockResolvedValue(respond(201, JSON.stringify({ id: 'mo9' })));
    await expect(admin.saveMotion({} as never)).resolves.toBe('mo9');
  });

  it('tolerates a 204 with no body on a read-shaped helper', async () => {
    fetchMock.mockResolvedValue(respond(204));
    await expect(admin.deleteProxy('x1')).resolves.toBeUndefined();
  });
});

/**
 * Lot Records (ADR 0024, #291). These four carry rules the route enforces on
 * its side too, and a helper that quietly sends the wrong thing would be
 * refused by the server rather than doing damage — but it would be refused
 * with a message the board cannot act on. The component tests mock this module
 * wholesale, so this is the only place the real request shapes are checked.
 */
describe('lot record helpers', () => {
  it('reports the feature being off as a state, not a failure', async () => {
    // Both flags off means the whole namespace answers 404. That is how the
    // feature stays dark, so the panel has to be able to tell it apart from a
    // read that failed.
    fetchMock.mockResolvedValue(respond(404, 'Not found'));
    await expect(admin.fetchLotViolations()).resolves.toEqual({
      enabled: false,
      rows: [],
    });
  });

  it('still throws on any other failure', async () => {
    fetchMock.mockResolvedValue(respond(500, 'D1 unavailable'));
    await expect(admin.fetchLotViolations()).rejects.toThrow('D1 unavailable');
  });

  it('narrows the read to one lot when asked, and to none when not', async () => {
    fetchMock.mockResolvedValue(respond(200, '[]'));
    await admin.fetchLotViolations('lot-a');
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/admin/lot-violations?lotId=lot-a',
    );

    await admin.fetchLotViolations();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/lot-violations');
  });

  it('asks for one record history by id', async () => {
    fetchMock.mockResolvedValue(respond(200, '[]'));
    await admin.fetchLotRecordEvents('v 1/2');
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/admin/lot-violations?events=v%201%2F2',
    );
  });

  it('sends a create as the create action, with the lot', async () => {
    fetchMock.mockResolvedValue(respond(201, JSON.stringify({ id: 'v9' })));
    await expect(
      admin.createLotViolation({
        lotId: 'lot-a',
        category: 'parking',
        effectiveDay: '2026-09-01',
        summary: 'Boat parked in the street',
      }),
    ).resolves.toEqual({ id: 'v9' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: 'create',
      lotId: 'lot-a',
      category: 'parking',
      effectiveDay: '2026-09-01',
      summary: 'Boat parked in the street',
    });
  });

  it('sends a transition as its own named action', async () => {
    fetchMock.mockResolvedValue(respond(204));
    await admin.transitionLotViolation('void', 'v1', 'duplicate');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: 'void',
      id: 'v1',
      reason: 'duplicate',
    });
  });

  it('omits the reason rather than sending it undefined', async () => {
    // `JSON.stringify` drops an undefined value, but only if the key is set
    // to undefined rather than to null — and the route reads a missing reason
    // as "none given" while a null would be a type error.
    fetchMock.mockResolvedValue(respond(204));
    await admin.transitionLotViolation('cure', 'v1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: 'cure',
      id: 'v1',
    });
  });

  it('never sends the lot or the status on an edit', async () => {
    // The lot IS the audience under ADR 0024, and status is transition-only.
    // The route refuses both, but a helper that sent them would be a bug
    // reported to the board as a mysterious refusal.
    fetchMock.mockResolvedValue(respond(204));
    await admin.editLotViolation('v1', {
      summary: 'Trailer parked in the street',
      internalNote: '',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      action: 'edit',
      id: 'v1',
      summary: 'Trailer parked in the street',
      internalNote: '',
    });
    expect(body).not.toHaveProperty('lotId');
    expect(body).not.toHaveProperty('status');
  });
});
