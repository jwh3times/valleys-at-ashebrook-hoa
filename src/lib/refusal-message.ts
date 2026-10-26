/**
 * The message to show for a refused API call. Some routes refuse with JSON
 * `{ message }` (a 409 that names its reason), others with plain text; either
 * way the reader sees the message, never the JSON. An empty body falls back to
 * `fallback` with the status.
 */
export async function refusalMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  const text = await res.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof parsed.message === 'string'
    )
      return parsed.message;
  } catch {
    // Plain text is already the message.
  }
  return text || `${fallback}: ${res.status}`;
}
