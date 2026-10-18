import { describe, it, expect, vi, afterEach } from 'vitest';
import { deleteDocument, resolveDuplicates } from '../../src/lib/admin';

// #442: a delete refused because a recorded change cites the document as
// evidence reaches the board as a sentence, not as the route's raw JSON.

afterEach(() => vi.unstubAllGlobals());

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

describe('a delete refused because the document is cited', () => {
  it('explains which kind of record cites the document', async () => {
    respond(409, { error: 'document-cited', citedBy: ['roster_change'] });
    await expect(deleteDocument('doc-1')).rejects.toThrow(
      "This document can't be deleted: a recorded roster change cites it as evidence.",
    );
  });

  it('names every kind of record that cites it', async () => {
    respond(409, {
      error: 'document-cited',
      citedBy: ['board_service_change', 'identity_event'],
    });
    await expect(deleteDocument('doc-1')).rejects.toThrow(
      "This document can't be deleted: a recorded board service change and identity record cite it as evidence.",
    );
  });

  it('says nothing was deleted when a duplicate resolution is refused', async () => {
    respond(409, {
      error: 'document-cited',
      citedBy: ['roster_change'],
      documentIds: ['doc-2'],
    });
    await expect(resolveDuplicates(['doc-1'], ['doc-2'])).rejects.toThrow(
      'Nothing was deleted or kept: a document marked for deletion is cited as evidence by a recorded roster change.',
    );
  });
});

describe('any other refused delete', () => {
  it("reports the server's own text for a 409 that is not a citation", async () => {
    // A real Response: its body can be read only once.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('Document is locked', { status: 409 })),
    );
    await expect(deleteDocument('doc-1')).rejects.toThrow('Document is locked');
  });
});
