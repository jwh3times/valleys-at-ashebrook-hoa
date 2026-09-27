import { OPERATOR_OBSERVATION, type Evidence } from './audit';

export function parseEvidence(
  body: unknown,
): { ok: true; value: Evidence } | { ok: false; error: string } {
  const raw = (body as Record<string, unknown> | null | undefined)?.evidence;
  if (raw === undefined || raw === null)
    return { ok: true, value: OPERATOR_OBSERVATION };
  if (typeof raw !== 'object')
    return { ok: false, error: 'evidence must be an object' };
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  switch (r.kind) {
    case 'operator_observation':
      return { ok: true, value: OPERATOR_OBSERVATION };
    case 'document': {
      const documentId = str(r.documentId);
      if (!documentId)
        return {
          ok: false,
          error: 'evidence.documentId is required for evidence.kind document',
        };
      return { ok: true, value: { kind: 'document', documentId } };
    }
    case 'meeting': {
      const meetingId = str(r.meetingId);
      if (!meetingId)
        return {
          ok: false,
          error: 'evidence.meetingId is required for evidence.kind meeting',
        };
      return { ok: true, value: { kind: 'meeting', meetingId } };
    }
    case 'election': {
      const electionId = str(r.electionId);
      if (!electionId)
        return {
          ok: false,
          error: 'evidence.electionId is required for evidence.kind election',
        };
      return { ok: true, value: { kind: 'election', electionId } };
    }
    case 'request': {
      const requestId = str(r.requestId);
      if (!requestId)
        return {
          ok: false,
          error: 'evidence.requestId is required for evidence.kind request',
        };
      return { ok: true, value: { kind: 'request', requestId } };
    }
    case 'external': {
      const externalReference = str(r.externalReference);
      if (!externalReference)
        return {
          ok: false,
          error:
            'evidence.externalReference is required for evidence.kind external',
        };
      return { ok: true, value: { kind: 'external', externalReference } };
    }
    default:
      return { ok: false, error: 'evidence.kind is invalid' };
  }
}

/** `substitutions?: [{termId, qualifyingLotId}]` -> a Map, or a 400. */
export function parseSubstitutions(
  body: unknown,
): { ok: true; value: Map<string, string> } | { ok: false; error: string } {
  const raw = (body as Record<string, unknown> | null | undefined)
    ?.substitutions;
  if (raw === undefined) return { ok: true, value: new Map() };
  if (!Array.isArray(raw))
    return { ok: false, error: 'substitutions must be an array' };
  const map = new Map<string, string>();
  for (const item of raw) {
    const r = item as Record<string, unknown> | null;
    const termId = r?.termId;
    const qualifyingLotId = r?.qualifyingLotId;
    if (typeof termId !== 'string' || termId.trim() === '')
      return { ok: false, error: 'Each substitution needs a termId' };
    if (typeof qualifyingLotId !== 'string' || qualifyingLotId.trim() === '')
      return {
        ok: false,
        error: 'Each substitution needs a qualifyingLotId',
      };
    map.set(termId.trim(), qualifyingLotId.trim());
  }
  return { ok: true, value: map };
}
