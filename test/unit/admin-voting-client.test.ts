import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeMotionVoting,
  openElection,
  openMotionVoting,
  saveElection,
} from '../../src/lib/admin';

afterEach(() => vi.unstubAllGlobals());

function successfulFetch() {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('admin live-voting client helpers', () => {
  it('opens a conducted election through the election lifecycle action', async () => {
    const fetchMock = successfulFetch();

    await openElection('e1');

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/elections',
      expect.objectContaining({
        body: JSON.stringify({ action: 'open', id: 'e1' }),
      }),
    );
  });

  it('opens member-motion voting through the motion lifecycle action', async () => {
    const fetchMock = successfulFetch();

    await openMotionVoting('m1');

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/motions',
      expect.objectContaining({
        body: JSON.stringify({ action: 'openVoting', id: 'm1' }),
      }),
    );
  });

  it('closes member-motion voting through the motion lifecycle action', async () => {
    const fetchMock = successfulFetch();

    await closeMotionVoting('m1');

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/motions',
      expect.objectContaining({
        body: JSON.stringify({ action: 'closeVoting', id: 'm1' }),
      }),
    );
  });

  it('sends source when creating an election', async () => {
    const fetchMock = successfulFetch();

    await saveElection({
      title: '2027 Board Election',
      seats: 2,
      electionDate: '2027-01-15',
      visibility: 'homeowner',
      source: 'conducted',
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/elections',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: '2027 Board Election',
          seats: 2,
          electionDate: '2027-01-15',
          visibility: 'homeowner',
          source: 'conducted',
        }),
      }),
    );
  });

  it('never sends create-immutable source when updating an election', async () => {
    const fetchMock = successfulFetch();

    await saveElection(
      {
        title: 'Updated title',
        source: 'conducted',
      },
      'e1',
    );

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/elections',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ id: 'e1', title: 'Updated title' }),
      }),
    );
  });
});
