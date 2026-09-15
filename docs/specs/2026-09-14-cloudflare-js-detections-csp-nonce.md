# Cloudflare JavaScript Detections and CSP nonces

Date: 2026-09-14  
Issue: [#335 — Check whether Cloudflare's JS Detections injection can take a CSP nonce](https://github.com/jwh3times/valleys-at-ashebrook-hoa/issues/335)

## Verdict

**Yes.** Cloudflare documents that, when a response's `Content-Security-Policy` header uses a
script nonce, its edge parses that response header and adds the nonce to the scripts JavaScript
Detections injects. The supported input is the HTTP response header; Cloudflare explicitly says
that JavaScript Detections does not support a nonce supplied through a CSP `<meta>` element.
[Cloudflare's current JavaScript Detections documentation](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp)
states both points, and the same language is present in
[Cloudflare's versioned documentation source](https://github.com/cloudflare/cloudflare-docs/blob/513a16a878a246e2f35ec55742308ba7e7436a48/src/content/partials/bots/content-security-policy-limitation.mdx#L8-L19).

This is a documented application-to-edge handoff, not a separate nonce setting in the Cloudflare
dashboard or API: the application places a nonce source in the CSP response header, and
Cloudflare's injection logic obtains the nonce by parsing that header. The documentation describes
Cloudflare as adding the nonce to its injected scripts, so “accept” is more precise than
“preserve”—those script elements did not exist in the origin HTML.
[Cloudflare's documentation source](https://github.com/cloudflare/cloudflare-docs/blob/513a16a878a246e2f35ec55742308ba7e7436a48/src/content/partials/bots/content-security-policy-limitation.mdx#L10-L18)
documents the mechanism.

## Documented behavior and requirements

- Zone-wide JavaScript Detections injects a script tag into HTML responses. Its script source uses
  a same-origin path beginning `/cdn-cgi/challenge-platform/`, and Cloudflare says the CSP must
  permit scripts from the site's own origin, such as with `script-src 'self'`.
  [Cloudflare: JavaScript Detections process and CSP limitations](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#process)
  documents the injection and source path; the
  [CSP subsection](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp)
  documents the same-origin requirement.

- A CSP nonce authorizes a script only when the script element's `nonce` value matches a
  `nonce-source` in the governing source list. This is why copying the response-header nonce to the
  injected script solves the browser-side CSP check.
  [Content Security Policy Level 3, §6.7.3.3](https://www.w3.org/TR/CSP/#match-element-to-source-list)
  defines the matching rule.

- The origin must generate a unique, unpredictable nonce each time it transmits a policy. CSP
  Level 3 requires a unique value per transmission and recommends at least 128 random bits from a
  cryptographically secure random number generator.
  [Content Security Policy Level 3, §7.1](https://www.w3.org/TR/CSP/#security-nonces)
  gives these requirements.

- The nonce must be in the HTTP `Content-Security-Policy` response header for Cloudflare to parse
  it. A nonce that appears only in a CSP `<meta>` element is unsupported by JavaScript Detections.
  [Cloudflare: CSP limitation](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp)
  states this boundary directly.

- Cloudflare recommends nonces instead of `'unsafe-inline'` for this integration. Separately, CSP
  Level 3 specifies that the presence of a nonce source or hash source prevents `'unsafe-inline'`
  from allowing all inline behavior.
  [Cloudflare's CSP guidance](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp)
  gives the recommendation, and
  [CSP Level 3, §6.7.3.2](https://www.w3.org/TR/CSP/#allow-all-inline)
  defines the override behavior.

## Application consequence

The documented integration shape is conceptually:

```http
Content-Security-Policy: script-src 'self' 'nonce-<fresh-per-response-value>' ...
```

The application uses the matching `<fresh-per-response-value>` on each origin-authored script it
intends to execute. Cloudflare then parses that response header and adds the nonce to its injected
scripts. The matching requirement and fresh-value requirement come from
[CSP Level 3's element matching algorithm](https://www.w3.org/TR/CSP/#match-element-to-source-list)
and [nonce security requirements](https://www.w3.org/TR/CSP/#security-nonces); Cloudflare's part is
the documented
[response-header parsing and injection behavior](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp).

**Inference:** this should allow the site to remove `'unsafe-inline'` without disabling JavaScript
Detections, provided every legitimate application script also receives the matching nonce (or is
otherwise allowed by the final policy). A production response should still be inspected before
removing the fallback: Cloudflare does not document edge cases such as multiple nonce sources,
multiple enforced CSP headers, or which policy it parses when both enforced and report-only
headers are present. The safest documented shape is one valid nonce source in the enforced CSP
response header.

## Supported alternatives

1. **Use the JavaScript Detections API script selectively.** Cloudflare documents a manual mode in
   which the application includes `/cdn-cgi/challenge-platform/scripts/jsd/api.js` and calls
   `window.cloudflare.jsd.executeOnce` only on selected pages. Cloudflare says not to combine this
   with zone-wide injection; the zone-wide setting should be disabled when manual mode is used. It
   also warns that manual-mode results may appear as `Unknown` in Bot Analytics even though the
   signal still contributes to bot scoring.
   [Cloudflare: JavaScript Detections API](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#api)

   **Inference:** because the application authors the manual inline callback and script elements,
   it can place its own matching nonce on them. That particular markup adaptation is governed by
   CSP's normal nonce matching rules, not separately promised by Cloudflare.
   [CSP Level 3, §6.7.3.3](https://www.w3.org/TR/CSP/#match-element-to-source-list)

2. **Disable zone-wide JavaScript Detections when the plan permits it.** Cloudflare says the
   feature is optional for Super Bot Fight Mode and Enterprise Bot Management, but automatically
   enabled and not disableable for Bot Fight Mode customers.
   [Cloudflare: enable JavaScript Detections](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#1-enable-javascript-detections)

3. **Suppress injection on responses with `Cache-Control: no-transform`.** Cloudflare documents
   that it will not inject JavaScript Detections into such a response, and that the corresponding
   detection field will be `missing`. This preserves a strict CSP only by foregoing the detection
   on those responses, so it is not equivalent to nonce integration.
   [Cloudflare: `no-transform` limitation](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-your-origin-sends-a-no-transform-header)

## Issue disposition

No Cloudflare support escalation is needed: the vendor's current official documentation directly
answers the research question and documents a supported nonce mechanism.
[Cloudflare: CSP limitation](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp)

The application implementation lives in `src/middleware.ts`: it adds one fresh nonce source to each
HTML response's enforced policy and applies the matching attribute to the scripts already present in
Astro's HTML. Its Workers tests cover freshness, the origin-script match, strict fallback behavior,
and repeated middleware finalization; a built-Worker smoke check additionally covered Astro's real
404 rewrite. **#335 should remain open until a deployed edge response confirms that Cloudflare
applies that same nonce to its later JavaScript Detections injection.** That live check is the final
part of the issue's positive-result completion condition.
[#335, “What would close this”](https://github.com/jwh3times/valleys-at-ashebrook-hoa/issues/335)
