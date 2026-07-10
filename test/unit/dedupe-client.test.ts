import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  uploadDocument,
  resolveDuplicates,
  DuplicateError,
} from '../../src/lib/admin';

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
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

const file = () => new File(['x'], 'a.pdf', { type: 'application/pdf' });

describe('uploadDocument duplicate handling', () => {
  it('throws a DuplicateError(kind=exact) on a 409 exact-duplicate', async () => {
    mockFetch(409, {
      error: 'exact-duplicate',
      existing: {
        id: '1',
        title: 'Existing',
        category: 'Other',
        visibility: 'board',
      },
    });
    await expect(
      uploadDocument(file(), 'T', 'Other', 'board'),
    ).rejects.toMatchObject({ kind: 'exact' });
  });

  it('throws a DuplicateError(kind=near) on a 409 near-duplicate', async () => {
    mockFetch(409, {
      warning: 'near-duplicate',
      similar: [{ id: '2', title: 'Close' }],
    });
    await expect(
      uploadDocument(file(), 'T', 'Other', 'board'),
    ).rejects.toMatchObject({ kind: 'near' });
  });

  it('sets confirmDuplicate on the form when confirmed', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', f);
    await uploadDocument(file(), 'T', 'Other', 'board', true);
    const form = f.mock.calls[0][1].body as FormData;
    expect(form.get('confirmDuplicate')).toBe('true');
  });
});

describe('resolveDuplicates', () => {
  it('POSTs a resolve action with keep/delete id arrays', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', f);
    await resolveDuplicates(['keep'], ['drop1', 'drop2']);
    const [, init] = f.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'resolve',
      keepIds: ['keep'],
      deleteIds: ['drop1', 'drop2'],
    });
  });
});

describe('DuplicateError', () => {
  it('is an Error subclass carrying its kind', () => {
    const e = new DuplicateError('exact', { existing: { id: '1' } });
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe('exact');
  });
});
