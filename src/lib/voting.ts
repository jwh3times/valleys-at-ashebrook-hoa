import type { CastBallotInput, CastMotionVoteInput } from './types';

async function cast(
  action: CastBallotInput | CastMotionVoteInput,
): Promise<void> {
  const response = await fetch('/api/vote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  if (response.ok) return;

  const message = (await response.text()).trim();
  throw new Error(message || `Voting request failed (${response.status})`);
}

export async function castBallot(
  input: Omit<CastBallotInput, 'action'>,
): Promise<void> {
  await cast({ action: 'castBallot', ...input });
}

export async function castMotionVote(
  input: Omit<CastMotionVoteInput, 'action'>,
): Promise<void> {
  await cast({ action: 'castMotionVote', ...input });
}
