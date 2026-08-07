import { afterEach, describe, expect, it, vi } from 'vitest';
import { castBallot, castMotionVote } from './voting';

afterEach(() => vi.unstubAllGlobals());

describe('voting write helpers', () => {
  it('posts an election ballot and surfaces readable response text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('Ballot is closed', { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      castBallot({
        electionId: 'e1',
        propertyId: 'p1',
        candidateIds: ['c1', 'c2'],
        castByOwnerId: 'o1',
        proxyId: null,
      }),
    ).rejects.toThrow('Ballot is closed');
    expect(fetchMock).toHaveBeenCalledWith('/api/vote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'castBallot',
        electionId: 'e1',
        propertyId: 'p1',
        candidateIds: ['c1', 'c2'],
        castByOwnerId: 'o1',
        proxyId: null,
      }),
    });
  });

  it('posts a motion vote', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await castMotionVote({
      motionId: 'm1',
      propertyId: 'p1',
      choice: 'yes',
      castByOwnerId: 'o1',
      proxyId: null,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/vote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'castMotionVote',
        motionId: 'm1',
        propertyId: 'p1',
        choice: 'yes',
        castByOwnerId: 'o1',
        proxyId: null,
      }),
    });
  });
});
