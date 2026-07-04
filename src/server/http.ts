// Small request-body helpers shared by the admin write endpoints.

/** Read a JSON body. `ok: false` means the body was not valid JSON (caller 400s). */
export async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  return request.json().then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  );
}

/** Trimmed string field from a parsed body, or '' if absent/blank/non-string. */
export function stringField(body: unknown, key: string): string {
  const v = (body as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === 'string' ? v.trim() : '';
}
