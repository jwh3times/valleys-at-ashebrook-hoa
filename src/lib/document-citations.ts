// The kinds of recorded change that may cite a document as evidence (#442).
// A cited document cannot be deleted. Client-safe, so the server's refusal
// and the board's wording of it share one list: the store maps each kind to
// its table, and the admin client to its phrase.
export const CITING_RECORD_KINDS = [
  'roster_change',
  'board_service_change',
  'identity_event',
] as const;

export type CitingRecordKind = (typeof CITING_RECORD_KINDS)[number];

/** How the board reads each kind, as in "a recorded roster change". */
export const CITING_RECORD_PHRASE: Record<CitingRecordKind, string> = {
  roster_change: 'roster change',
  board_service_change: 'board service change',
  identity_event: 'identity record',
};
