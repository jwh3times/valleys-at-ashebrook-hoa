import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Astro hashes every inline script it generates, which is what lets
 * `script-src` refuse 'unsafe-inline'. It deliberately does NOT touch a script
 * marked `is:inline`, so any of those must be hashed by hand in
 * `astro.config.mjs` under `security.csp.scriptDirective.hashes`.
 *
 * A hand-copied hash rots the moment someone edits the script, and the failure
 * is silent: the browser blocks the script, nothing reaches the server, and the
 * feature simply stops working. On `/verify-property` that feature is the
 * Turnstile callback that captures the token, so homeowner verification would
 * fail with nothing in the logs to explain it.
 *
 * These tests recompute the hashes from the page sources and fail on drift.
 */

const ROOT = process.cwd();
const CONFIG = 'astro.config.mjs';

/** Pages known to carry a hand-written inline script. */
const PAGES_WITH_INLINE_SCRIPTS = ['src/pages/verify-property.astro'];

function sha256Base64(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

/**
 * Every `is:inline` script BODY in a page, in source order. A
 * `<script is:inline src="…">` is an external script carrying no body, and no
 * hash applies to it, so empty bodies are dropped.
 */
function inlineScriptBodies(relativePath: string): string[] {
  const source = readFileSync(join(ROOT, relativePath), 'utf8');
  return [
    ...source.matchAll(/<script[^>]*\bis:inline\b[^>]*>(.*?)<\/script>/gs),
  ]
    .map((match) => match[1])
    .filter((body) => body.trim() !== '');
}

describe('CSP hashes for hand-written inline scripts', () => {
  it('covers every is:inline script with a configured hash', () => {
    const config = readFileSync(join(ROOT, CONFIG), 'utf8');
    const missing: string[] = [];
    for (const page of PAGES_WITH_INLINE_SCRIPTS) {
      for (const body of inlineScriptBodies(page)) {
        const hash = sha256Base64(body);
        if (!config.includes(hash)) missing.push(`${page} → ${hash}`);
      }
    }
    expect(
      missing,
      `Inline script changed. Put these hashes in security.csp.scriptDirective.hashes in ${CONFIG}:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('knows about every page that has one', () => {
    // The list above is hand-maintained, so this keeps it honest: a new page
    // with an inline script must be added to it, or nothing would ever check
    // that its hash is configured and the script would be blocked in
    // production while every test still passed.
    const found = globSync('src/pages/**/*.astro', { cwd: ROOT })
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => inlineScriptBodies(path).length > 0)
      .sort();
    expect(found).toEqual([...PAGES_WITH_INLINE_SCRIPTS].sort());
  });
});
