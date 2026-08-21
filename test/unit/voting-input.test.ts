import { describe, expect, it } from 'vitest';
import { normalizeVoteAction } from '../../src/server/content/voting';

describe('normalizeVoteAction', () => {
  it('normalizes an owner-cast election ballot', () => {
    expect(
      normalizeVoteAction({
        action: 'castBallot',
        electionId: ' election-1 ',
        propertyId: ' property-1 ',
        candidateIds: [' candidate-1 ', 'candidate-2'],
        castByPersonId: ' owner-1 ',
      }),
    ).toEqual({
      ok: true,
      value: {
        action: 'castBallot',
        electionId: 'election-1',
        propertyId: 'property-1',
        candidateIds: ['candidate-1', 'candidate-2'],
        castByPersonId: 'owner-1',
        proxyId: null,
      },
    });
  });

  it('normalizes a proxy-cast motion vote', () => {
    expect(
      normalizeVoteAction({
        action: 'castMotionVote',
        motionId: ' motion-1 ',
        propertyId: ' property-1 ',
        choice: 'abstain',
        proxyId: ' proxy-1 ',
      }),
    ).toEqual({
      ok: true,
      value: {
        action: 'castMotionVote',
        motionId: 'motion-1',
        propertyId: 'property-1',
        choice: 'abstain',
        castByPersonId: null,
        proxyId: 'proxy-1',
      },
    });
  });

  it.each([undefined, null, '', 'castVote', 7])(
    'rejects unknown action %j',
    (action) => {
      const result = normalizeVoteAction({ action });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/unknown action/i);
    },
  );

  it.each([
    ['electionId', { electionId: '   ' }],
    ['propertyId', { propertyId: '' }],
    ['candidateIds', { candidateIds: ['candidate-1', ' '] }],
    ['castByPersonId', { castByPersonId: ' ', proxyId: null }],
  ])('rejects an empty ballot %s', (_label, override) => {
    const result = normalizeVoteAction({
      action: 'castBallot',
      electionId: 'election-1',
      propertyId: 'property-1',
      candidateIds: ['candidate-1'],
      castByPersonId: 'owner-1',
      proxyId: null,
      ...override,
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    ['motionId', { motionId: '   ' }],
    ['propertyId', { propertyId: '' }],
    ['proxyId', { castByPersonId: null, proxyId: ' ' }],
  ])('rejects an empty motion-vote %s', (_label, override) => {
    const result = normalizeVoteAction({
      action: 'castMotionVote',
      motionId: 'motion-1',
      propertyId: 'property-1',
      choice: 'yes',
      castByPersonId: null,
      proxyId: 'proxy-1',
      ...override,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects empty and duplicate candidate arrays', () => {
    for (const candidateIds of [
      [],
      ['candidate-1', 'candidate-1'],
      ['candidate-1', ' candidate-1 '],
    ]) {
      const result = normalizeVoteAction({
        action: 'castBallot',
        electionId: 'election-1',
        propertyId: 'property-1',
        candidateIds,
        castByPersonId: 'owner-1',
      });
      expect(result.ok).toBe(false);
    }
  });

  it.each(['recused', 'absent', '', null, 1])(
    'rejects invalid motion choice %j',
    (choice) => {
      const result = normalizeVoteAction({
        action: 'castMotionVote',
        motionId: 'motion-1',
        propertyId: 'property-1',
        choice,
        castByPersonId: 'owner-1',
      });
      expect(result.ok).toBe(false);
    },
  );

  it.each(['castBallot', 'castMotionVote'] as const)(
    'rejects both provenance fields for %s',
    (action) => {
      const result = normalizeVoteAction(
        action === 'castBallot'
          ? {
              action,
              electionId: 'election-1',
              propertyId: 'property-1',
              candidateIds: ['candidate-1'],
              castByPersonId: 'owner-1',
              proxyId: 'proxy-1',
            }
          : {
              action,
              motionId: 'motion-1',
              propertyId: 'property-1',
              choice: 'yes',
              castByPersonId: 'owner-1',
              proxyId: 'proxy-1',
            },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/exactly one/i);
    },
  );

  it.each(['castBallot', 'castMotionVote'] as const)(
    'rejects neither provenance field for %s',
    (action) => {
      const result = normalizeVoteAction(
        action === 'castBallot'
          ? {
              action,
              electionId: 'election-1',
              propertyId: 'property-1',
              candidateIds: ['candidate-1'],
            }
          : {
              action,
              motionId: 'motion-1',
              propertyId: 'property-1',
              choice: 'yes',
            },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/exactly one/i);
    },
  );
});
