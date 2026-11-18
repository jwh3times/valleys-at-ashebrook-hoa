# Verification

How to prove a change works and that a claim is true before reporting either. A clean
`npm run lint` and a green suite catch none of the failures below; each one reached review or
production.

## A new test must fail on the old code

Run every new test against the pre-change implementation and confirm it goes red:
`git stash push <the changed source files>`, run the test, `git stash pop`. A test that passes on
both says nothing. The shapes it has taken here:

1. **The fixture the change destroys.** A test filtered review flags by a seeded ballot id, but the
   old code deleted and reinserted ballots, so the filter matched nothing and passed either way.
   Never identify a row by the attribute the change is about; find it through a stable one (its
   lot).
2. **A string the code never emits.** `not.toContain('…&#39;…')` passed against output where Astro
   renders a literal apostrophe. Check the exact rendered text before asserting its absence.
3. **A cast that hides a wrong constant.** Capability strings that don't exist type-checked behind
   `as unknown as App.Locals`. Check every constant behind such a cast against the real union by
   hand.
4. **A cast that survives a field removal.** After a field left `AuthContext`, test contexts built
   behind casts kept it, and one test's caller was board only through the dead field. After removing
   a context field, grep the cast literals and spreads for it: the compiler can't see there.
5. **An earlier limit that answers first.** A test of a new 320-character cap sent 321 characters,
   but a 200-character cap refused it first, with a message the loose pattern also matched. List
   every earlier check on the same input, test the limit that sits under them, and pin the new
   refusal's exact text.
6. **A guard can't fail on the old code.** A test that something stays absent or unchanged passes on
   the old code by nature. Prove it by mutation instead: break each half of the new condition on
   purpose and confirm the guard goes red. In acceptance criteria, ask only the change-proving tests
   to fail on the old code.
7. **An absence check on text the change stops rendering.** `not.toContain('<reference>')` proved a
   row was hidden, until the page stopped showing references at all. Before changing what a row
   renders, re-anchor such assertions on something that renders either way.

Related:

- **Anchor every absence assertion with a positive control.** A "does not leak X" assertion
  downstream of the code that removes X can't fail. Render the same fixture as a caller who should
  see X and assert it appears.
- **Don't build expected values with the function under test.** `paymentReference('pay-1')` as the
  expected value is a tautology; pin a literal.
- **A test's name can claim more than its body.** "Never loses a cent to floating point" also passed
  with a naive `parseFloat(x) * 100`, because it measured the third-decimal guard, not the
  arithmetic. A BigInt property test with no float in the reference is the real check.
- **When the tests came second, budget a mutation run.** On #545 a 22-rule mutation run found a rule
  no test held.
- **A scan that reports clean** must be checked against a case it should catch. A regex built in a
  template literal turned `\b` into a backspace character and matched nothing for four slices, with
  no lint rule objecting. Build such patterns by concatenation with doubled backslashes.

## Writing tests here

- **Pages that read `locals.site`** are tested under `test/server`, never `test/unit`:
  `tsconfig.node.json` doesn't load `src/env.d.ts`, so `npm run check` fails there even though the
  test passes. `console.log` doesn't show in the Workers pool; for a throwaway probe, throw an
  `Error` holding the report.
- **Seed every feature flag in `permission-matrix.test.ts`.** A route behind an unseeded flag
  answers 404 before its capability gate, and 404 satisfies both "not 401" and "not 403".
- **A test that pins a CHECK constraint** should resolve the migration that most recently defines
  it, not hard-code a filename that a later rebuild supersedes.
- **drizzle-orm wraps SQLite errors**, so `.rejects.toThrow(/CHECK/i)` must inspect `.cause` too,
  as the local `expectRejectsWithReason` helper in `test/server/proxy-schema.test.ts` does.
- **Assert spacing on collapsed whitespace** (`html.replace(/\s+/g, ' ')`). Astro's JSX glues a
  line-ending `{expr}` onto the next line's text ("HOAboard"), and drops a line break between text
  and an element, so render the page and read it.
- **Timeouts only in a full local run.** A jsdom test that passes alone can exceed Vitest's 5 s
  default in a full `npm test` on a loaded machine. `user.type` costs about 21 ms per keystroke in a
  big panel. Measure the file alone with `--testTimeout=1500`; where typing isn't what's tested,
  set the field with one `fireEvent.change`, then break the component and confirm the faster test
  still fails. A per-test timeout is a trailing number (`}, 15_000);`); the options-object form
  makes Prettier re-indent the whole body.
- **Reproducing a failure that depends on local secrets.** Back up `.dev.vars` to a scratch
  directory, install one with fake values for every key `vitest.workers.config.ts`'s `bindings`
  don't set, then restore the original byte for byte (`cmp`); never print it. The fake
  `DRIVE_TOKEN_KEY` must be base64 of exactly 32 bytes, or Drive counts as unconfigured and the run
  hides the failures it should show.
- **`npm test | tail` hides the exit code.** Read the `Tests` line, or capture `$?` without a pipe.

## UI that tests can't see

- **Check every `className` resolves** in `src/styles/global.css`. A panel once used class names
  from no stylesheet and would have rendered unstyled. The admin vocabulary is `panel-card`,
  `field-grid`, `field`, `btn btn--small`, `row-link` and `list-row`; public pages use
  `page-section`, `page-lead` and their own `*-list` block.
- **"The list is empty" and "there is no list" are different states.** A dues ledger whose entries
  sum to zero still exists, so branching on `null` rendered an empty bordered list. Decide an empty
  state from the lines that will render.
- **Guard a reload that can race another.** Number every read and let only the newest write, and
  disable the filter while a write is in flight.

## Production is stricter, or different

- **The local runtime can be more permissive than production.** Miniflare accepts
  `PRAGMA foreign_keys` and remote D1 rejects it ([migrations](./migrations.md#sqlite-and-d1-traps)).
- **Verify any change to response headers or content policy against production right after the
  deploy, with a revert ready.** Cloudflare's JavaScript Detections injects an inline script carrying
  a per-request token into every HTML response at the edge. Nothing local sees it, so a hash-based
  CSP passed every local check and broke on the first production request (v0.18.24, reverted in
  v0.18.25). Two related facts:
  - CSP Level 3 ignores `'unsafe-inline'` when the policy holds any hash or nonce, so adding it back
    beside hashes is not a partial rollback.
  - With `output: 'server'` every page is on demand, so Astro's `security.csp` arrives as a header,
    competing with middleware's, not as a `<meta>`.
- **Astro's CSRF check answers 403 to a POST without an `Origin` header** unless its content type is
  `application/json`; a bodyless `-X POST` is refused. The comparison is exact, so a trailing slash
  on the origin fails it. For an authenticated one-off POST to the live site, use a same-origin
  `fetch` in the browser console, which carries the session cookie and origin. In PowerShell, write
  `curl.exe`: `curl` is `Invoke-WebRequest`.
- **A fake provider can't catch a provider's API change.** Stripe API `2026-10-28.endive` rejected
  `payment_method_types` on Checkout Sessions, and only the sandbox rehearsal showed it. The
  rehearsal's steps are in [`SETUP.md`](../../SETUP.md#online-payments-stripe-sandbox).
- **Read the library, not its docs**, for Better Auth behavior: verify against
  `node_modules/better-auth/dist`. Sessions live in Workers KV, not the D1 `sessions` table, so
  editing D1 rows changes nothing.

## Claims and decisions

- **Advisories and issue bodies are proposals.** Three findings of the 2026-09-04 security review
  needed more than their advisory prescribed. Astro decodes paths repeatedly, so one `decodeURI`
  still let `/api/%2561dmin/…` through. Check a prescribed fix against how the code actually behaves.
- **Verify an issue body's factual claims against the current ADRs and code** before recording a
  decision it frames. #298 told the board an election couldn't be recounted, from a superseded ADR,
  and the board decided with that wording in front of it. When a decision lands, update the issue
  body that framed it.
- **A minutes date must be checkable.** Confirm a decision could have been taken at the meeting a
  date names.
- **When an entry criterion defines its own term, read the definition** before judging whether it
  is met.
- **Look at the page image before calling a scan unreadable.** OCR lost the collection policy's
  figures, but rendering the PDF showed them.
- **Date a corpus document before treating it as current practice.** The association is
  self-managed ([domain](./domain.md#the-association-is-self-managed)).
- **Don't take "no human follow-up needed" from a review agent** when a change adds a migration or a
  feature flag: `docs-updater` said so on three of four Lot Records slices, wrongly each time.
- **A checklist step that cannot fail is not running.** The board update in end-session did nothing
  for weeks because `gh` lacked the `project` scope, and nothing errored.
