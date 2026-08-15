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
  [
    'memberAction',
    () => admin.memberAction({ action: 'approve', queueId: 'q1' }),
  ],
  ['deleteMeeting', () => admin.deleteMeeting('m1')],
  ['deleteMotion', () => admin.deleteMotion('mo1')],
  ['deleteResolution', () => admin.deleteResolution('r1')],
  ['deleteElection', () => admin.deleteElection('e1')],
  ['deleteProxy', () => admin.deleteProxy('x1')],
  ['saveMeeting', () => admin.saveMeeting({} as never)],
  ['setMemberAttendance', () => admin.setMemberAttendance('m1', [])],
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
